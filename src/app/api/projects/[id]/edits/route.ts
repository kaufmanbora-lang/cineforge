import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { latestMoviePlan } from "@/server/movie/repository";
import { analyzeEdit, buildTimelineIndex } from "@/server/movie/impact-analysis";
import { buildProjectContext } from "@/server/movie/context-builder";
import { enhanceShotPrompt, proposeDialogueEdit } from "@/server/providers/openai";
import { enqueueJobs } from "@/server/movie/queue";
import { contentHash } from "@/server/movie/content-hash";
import { query, transaction } from "@/server/db";
import type { MoviePlan, Shot } from "@/domain/movie";

export const runtime = "nodejs";

const Body = z.object({ command: z.string().min(3).max(5_000), sceneId: z.string().optional(), shotId: z.string().optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { command, sceneId, shotId } = Body.parse(await request.json());
    const plan = await latestMoviePlan(id);
    if (!plan) return NextResponse.json({ error: "No screenplay is available for impact analysis." }, { status: 409 });
    const impact = analyzeEdit(command, buildTimelineIndex(plan.scenes), { sceneId, shotId });
    const target = impact.affected[0];
    const scene = plan.scenes.find((item) => item.id === target.sceneId)!;
    const shot = scene.shots.find((item) => item.id === target.shotId)!;
    const projectContext = await buildProjectContext({ projectId: id, selectedSceneId: scene.id });
    const projectRows = await query<{ model_id: string; resolution: string; aspect_ratio: string }>("SELECT model_id,resolution,aspect_ratio FROM projects WHERE id=$1", [id]);
    if (!projectRows[0]) return NextResponse.json({ error: "Проект не найден." }, { status: 404 });
    const operationRows = await query<{ last_operation: { modelId?: string; output?: { interactionId?: string } } | null }>("SELECT last_operation FROM shots WHERE id=$1 AND project_id=$2", [shot.id, id]);

    let nextShot: Shot;
    let revisedDialogue: { text: string; delivery: string } | undefined;
    let promptResult: { original: string; enhanced: string } | undefined;
    if (impact.intent === "dialogue" && shot.audioContext.dialogue.length) {
      const dialogue = shot.audioContext.dialogue.find((line) => target.dialogueIds.includes(line.id)) ?? shot.audioContext.dialogue[0];
      revisedDialogue = await proposeDialogueEdit({ command, dialogue, context: projectContext });
      const revisedAudio = {
        ...shot.audioContext,
        cleanStart: true,
        forbidCarryOver: [...new Set([
          ...shot.audioContext.forbidCarryOver,
          "all previous generated dialogue",
          "all previous music and sound effects",
        ])],
        dialogue: shot.audioContext.dialogue.map((line) => line.id === dialogue.id
          ? { ...line, text: revisedDialogue!.text, delivery: revisedDialogue!.delivery }
          : line),
      };
      const originalPrompt = shot.generationPrompt?.prompt ?? shot.action;
      nextShot = {
        ...shot,
        audioContext: revisedAudio,
        generationPrompt: {
          ...(shot.generationPrompt ?? { sceneIntent: shot.action, modelId: projectRows[0].model_id, negativeDirectives: [], referenceAssetIds: [], seed: null }),
          prompt: `${originalPrompt}\nTARGETED GOOGLE NATIVE DIALOGUE EDIT FOR SHOT ${shot.id}: ${dialogue.characterName} says exactly \"${revisedDialogue.text}\" with ${revisedDialogue.delivery} delivery. Generate this speech as synchronized native Google audio in the same established character voice. Do not add narration, dubbing, TTS overlay or any other speaker. Preserve every unaffected story fact and visual detail.`,
        },
      };
    } else {
      const originalPrompt = shot.generationPrompt?.prompt ?? shot.action;
      promptResult = await enhanceShotPrompt({
        original: `${originalPrompt}\nTargeted edit: ${command}. Never change content outside shot ${shot.id}.`,
        modelId: projectRows[0].model_id,
        context: projectContext,
      });
      nextShot = {
        ...shot,
        generationPrompt: {
          ...(shot.generationPrompt ?? { sceneIntent: shot.action, modelId: projectRows[0].model_id, negativeDirectives: [], referenceAssetIds: [], seed: null }),
          prompt: promptResult.enhanced,
        },
      };
    }
    const specHash = contentHash({
      shot: nextShot,
      model: projectRows[0].model_id,
      resolution: projectRows[0].resolution,
      aspectRatio: projectRows[0].aspect_ratio,
      references: shot.continuity.requiredReferences,
    });
    const activeVersion = await query<{ content_hash: string }>(
      "SELECT sv.content_hash FROM shot_versions sv WHERE sv.shot_id=$1 AND sv.active=true ORDER BY sv.created_at DESC LIMIT 1",
      [shot.id],
    );
    if (activeVersion[0]?.content_hash === specHash) {
      return NextResponse.json({ impact, queued: 0, alreadyApplied: true, prompt: promptResult, revisedDialogue, nativeGoogleAudio: Boolean(revisedDialogue), videoFramesPreserved: false });
    }
    await persistTargetedShotEdit(id, plan, nextShot, specHash);
    const omniEditable = Boolean(operationRows[0]?.last_operation?.output?.interactionId) && operationRows[0]?.last_operation?.modelId?.startsWith("gemini-omni");
    const queued = await enqueueJobs([{
      projectId: id,
      sceneId: scene.id,
      shotId: shot.id,
      type: "generate-shot",
      idempotencyKey: `generate-shot:${shot.id}:${specHash}`,
      dependencies: shot.dependencies,
      priority: 20_000,
      payload: {
        shot: nextShot,
        specHash,
        editCommand: revisedDialogue
          ? `Replace only the selected line with \"${revisedDialogue.text}\" (${revisedDialogue.delivery}). Use synchronized native Google speech in the same established character voice; no narrator or overlay.`
          : command,
        ...(omniEditable ? { providerModelId: "gemini-omni-flash-preview" } : {}),
      },
    }]);
    return NextResponse.json({ impact, queued, prompt: promptResult, revisedDialogue, nativeGoogleAudio: Boolean(revisedDialogue), videoFramesPreserved: false }, { status: 202 });
  } catch (error) {
    return apiError(error, 400);
  }
}

async function persistTargetedShotEdit(projectId: string, plan: MoviePlan, nextShot: Shot, specHash: string): Promise<void> {
  await transaction(async (client) => {
    const project = await client.query<{ maximum_version: number }>(
      `SELECT (SELECT COALESCE(max(version),0)::int FROM movie_plan_versions WHERE project_id=p.id) maximum_version
       FROM projects p WHERE p.id=$1 FOR UPDATE`,
      [projectId],
    );
    if (!project.rows[0]) throw Object.assign(new Error("Проект не найден."), { status: 404 });
    const nextPlan: MoviePlan = {
      ...plan,
      scenes: plan.scenes.map((scene) => ({
        ...scene,
        shots: scene.shots.map((shot) => shot.id === nextShot.id ? nextShot : shot),
      })),
    };
    const planHash = contentHash(nextPlan);
    const saved = await client.query<{ version: number }>(
      `INSERT INTO movie_plan_versions (project_id,version,content_hash,plan)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id,content_hash) DO UPDATE SET plan=EXCLUDED.plan
       RETURNING version`,
      [projectId, project.rows[0].maximum_version + 1, planHash, JSON.stringify(nextPlan)],
    );
    await client.query(
      `UPDATE shots SET state='planned',generation_spec=$2,audio_context=$3,continuity_state=$4,
         content_hash=$5,last_error=NULL,updated_at=now() WHERE id=$1 AND project_id=$6`,
      [nextShot.id, JSON.stringify(nextShot), JSON.stringify(nextShot.audioContext), JSON.stringify(nextShot.continuity), specHash, projectId],
    );
    await client.query(
      "UPDATE projects SET current_plan_version=$2,status='generating',last_error=NULL,final_movie_storage_key=NULL,updated_at=now() WHERE id=$1",
      [projectId, saved.rows[0].version],
    );
  });
}
