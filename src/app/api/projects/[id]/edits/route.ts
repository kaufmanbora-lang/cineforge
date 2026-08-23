import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { latestMoviePlan } from "@/server/movie/repository";
import { analyzeEdit, buildTimelineIndex } from "@/server/movie/impact-analysis";
import { buildProjectContext } from "@/server/movie/context-builder";
import { enhanceShotPrompt, proposeDialogueEdit } from "@/server/providers/openai";
import { enqueueDialoguePatch, enqueueJobs } from "@/server/movie/queue";
import { contentHash } from "@/server/movie/content-hash";
import { query } from "@/server/db";

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

    if (impact.intent === "dialogue" && shot.audioContext.dialogue.length) {
      const dialogue = shot.audioContext.dialogue.find((line) => target.dialogueIds.includes(line.id)) ?? shot.audioContext.dialogue[0];
      const revised = await proposeDialogueEdit({ command, dialogue, context: projectContext });
      const assetRows = await query<{ id: string; storage_key: string }>(
        `SELECT a.id,a.storage_key FROM generation_assets a JOIN shot_versions sv ON sv.id=a.shot_version_id
         WHERE a.project_id=$1 AND a.shot_id=$2 AND sv.active=true AND a.kind='video' LIMIT 1`,
        [id, shot.id],
      );
      if (!assetRows[0]) return NextResponse.json({ error: "The affected shot has no completed source asset." }, { status: 409 });
      const payload = {
        dialogueId: dialogue.id,
        characterId: dialogue.characterId,
        text: revised.text,
        delivery: revised.delivery,
        startSeconds: dialogue.startSeconds,
        durationSeconds: dialogue.durationSeconds,
        originalAssetId: assetRows[0].id,
        originalStorageKey: assetRows[0].storage_key,
      };
      const dialogueJob = await enqueueDialoguePatch({
        projectId: id,
        sceneId: scene.id,
        shotId: shot.id,
        payload,
        idempotencyKey: `dialogue-patch:${shot.id}:${contentHash(payload)}`,
      });
      const inProgress = ["queued", "generating", "validating", "retrying"].includes(dialogueJob.state);
      return NextResponse.json({ impact, jobId: dialogueJob.jobId, queued: dialogueJob.queued, alreadyApplied: dialogueJob.state === "completed", revisedDialogue: revised, videoFramesPreserved: true }, { status: inProgress ? 202 : 200 });
    }

    const originalPrompt = shot.generationPrompt?.prompt ?? shot.action;
    const enhanced = await enhanceShotPrompt({
      original: `${originalPrompt}\nTargeted edit: ${command}. Never change content outside shot ${shot.id}.`,
      modelId: projectRows[0].model_id,
      context: projectContext,
    });
    const nextShot = {
      ...shot,
      generationPrompt: {
        ...(shot.generationPrompt ?? { sceneIntent: shot.action, modelId: projectRows[0].model_id, negativeDirectives: [], referenceAssetIds: [], seed: null }),
        prompt: enhanced.enhanced,
      },
    };
    const specHash = contentHash({
      prompt: nextShot.generationPrompt,
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
      return NextResponse.json({ impact, queued: 0, alreadyApplied: true, prompt: enhanced, videoFramesPreserved: false });
    }
    await query("UPDATE shots SET state='planned',generation_spec=$2,content_hash=$3 WHERE id=$1", [shot.id, JSON.stringify(nextShot), specHash]);
    await query("UPDATE projects SET status='generating',last_error=NULL,updated_at=now() WHERE id=$1", [id]);
    const omniEditable = Boolean(operationRows[0]?.last_operation?.output?.interactionId) && operationRows[0]?.last_operation?.modelId?.startsWith("gemini-omni");
    const queued = await enqueueJobs([{
      projectId: id,
      sceneId: scene.id,
      shotId: shot.id,
      type: "generate-shot",
      idempotencyKey: `generate-shot:${shot.id}:${specHash}`,
      dependencies: shot.dependencies,
      priority: 20_000,
      payload: { shot: nextShot, specHash, editCommand: command, ...(omniEditable ? { providerModelId: "gemini-omni-flash-preview" } : {}) },
    }]);
    return NextResponse.json({ impact, queued, prompt: enhanced, videoFramesPreserved: false }, { status: 202 });
  } catch (error) {
    return apiError(error, 400);
  }
}
