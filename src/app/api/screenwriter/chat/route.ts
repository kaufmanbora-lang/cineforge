import { z } from "zod";
import { apiError } from "@/server/http";
import { query } from "@/server/db";
import { env } from "@/server/env";
import { buildProjectContext } from "@/server/movie/context-builder";
import { createScreenwriterStream, generateStructuredMoviePlan, transcribeMovieDescription } from "@/server/providers/openai";
import { assertRateLimit } from "@/server/rate-limit";
import { adaptMoviePlanPrompts } from "@/server/providers/video/prompt-adapters";
import { latestMoviePlan, persistMoviePlan } from "@/server/movie/repository";
import { estimateGeneration } from "@/domain/estimation";
import { getVideoModel, type Resolution } from "@/domain/video-models";

export const runtime = "nodejs";
export const maxDuration = 800;

const Body = z.object({
  message: z.string().min(1).max(30_000),
  projectId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  previousResponseId: z.string().optional(),
  selectedSceneId: z.string().optional(),
  mode: z.enum(["screenwriter", "director"]).default("screenwriter"),
  modelId: z.string().optional(),
  attachments: z.array(z.string().startsWith("data:image/").max(12_000_000)).max(3).default([]),
});

const PrepareMovieAction = z.object({
  projectId: z.string().uuid().nullable(),
  durationSeconds: z.number().int().min(1).max(3_600),
  modelId: z.string(),
  resolution: z.enum(["preview", "720p", "1080p", "4k"]),
});

export async function POST(request: Request) {
  try {
    if (new URL(request.url).searchParams.get("transcribe") === "1") {
      assertRateLimit(request, "voice transcription", 20, 60_000);
      const form = await request.formData();
      const audio = form.get("audio");
      if (!(audio instanceof File) || !audio.size) return Response.json({ error: "Запись с микрофона не получена." }, { status: 400 });
      if (audio.size > 20_000_000) return Response.json({ error: "Запись слишком большая. Максимальный размер — 20 МБ." }, { status: 413 });
      if (!/^(audio|video)\//.test(audio.type)) return Response.json({ error: "Неподдерживаемый формат записи." }, { status: 415 });
      const text = await transcribeMovieDescription(audio);
      return Response.json({ text });
    }
    assertRateLimit(request, "screenwriter", 30, 60_000);
    const body = Body.parse(await request.json());
    let conversationId = body.conversationId;
    let previousResponseId: string | undefined;
    try {
      if (!conversationId) {
        const rows = await query<{ id: string }>(
          "INSERT INTO conversations (project_id,workspace_id,mode) VALUES ($1,$2,$3) RETURNING id",
          [body.projectId ?? null, env().DEFAULT_WORKSPACE_ID, body.mode],
        );
        conversationId = rows[0].id;
      } else {
        const conversations = await query<{ project_id: string | null; workspace_id: string; last_response_id: string | null }>(
          "SELECT project_id,workspace_id,last_response_id FROM conversations WHERE id=$1",
          [conversationId],
        );
        const conversation = conversations[0];
        if (!conversation || conversation.workspace_id !== env().DEFAULT_WORKSPACE_ID) {
          throw Object.assign(new Error("Диалог ИИ-сценариста не найден."), { status: 404 });
        }
        if (conversation.project_id && body.projectId && conversation.project_id !== body.projectId) {
          throw Object.assign(new Error("Диалог ИИ-сценариста принадлежит другому проекту."), { status: 409 });
        }
        if (!conversation.project_id && body.projectId) {
          await query("UPDATE conversations SET project_id=$2 WHERE id=$1 AND project_id IS NULL", [conversationId, body.projectId]);
        }
        // The durable conversation is authoritative. Never accept an arbitrary
        // response ID from a different browser tab/project as model context.
        previousResponseId = conversation.last_response_id ?? undefined;
      }
      await query("INSERT INTO messages (conversation_id,role,content) VALUES ($1,'user',$2)", [conversationId, JSON.stringify({ text: body.message, attachmentCount: body.attachments.length })]);
    } catch (error) {
      if (typeof error === "object" && error && "status" in error) throw error;
      // Streaming remains available when local infrastructure is temporarily offline.
    }
    const projectContext = await buildProjectContext({ projectId: body.projectId, selectedSceneId: body.selectedSceneId }).catch(() => ({
      projectId: body.projectId,
      selectedSceneId: body.selectedSceneId,
      durationSeconds: 1_200,
    }));
    const stream = await createScreenwriterStream({
      message: body.message,
      previousResponseId,
      context: projectContext,
      mode: body.mode,
      modelId: body.modelId,
      attachments: body.attachments,
    });
    const encoder = new TextEncoder();
    let fullText = "";
    let responseId = previousResponseId ?? null;
    let usage: unknown = null;
    const responseStream = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ conversationId })}\n\n`));
          for await (const event of stream) {
            const record = event as unknown as Record<string, unknown>;
            if (record.type === "response.output_text.delta") {
              const delta = String(record.delta ?? "");
              fullText += delta;
              controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`));
            }
            if (record.type === "response.function_call_arguments.done") {
              const action = PrepareMovieAction.parse(JSON.parse(String(record.arguments ?? "{}")));
              if (body.projectId && action.projectId && body.projectId !== action.projectId) throw new Error("The requested project does not match the active conversation project.");
              const prepared = await prepareMovieFromScreenwriterAction(action, body.message, body.projectId);
              if (conversationId) await query(
                "UPDATE conversations SET project_id=COALESCE(project_id,$2) WHERE id=$1 AND (project_id IS NULL OR project_id=$2)",
                [conversationId, prepared.projectId],
              );
              controller.enqueue(encoder.encode(`event: action\ndata: ${JSON.stringify({ name: "create_movie_from_current_screenplay", prepared })}\n\n`));
            }
            if (record.type === "response.completed") {
              const response = record.response as Record<string, unknown> | undefined;
              responseId = String(response?.id ?? responseId ?? "");
              usage = response?.usage ?? null;
            }
          }
          if (conversationId) {
            try {
              await query("INSERT INTO messages (conversation_id,role,content,response_id,usage) VALUES ($1,'assistant',$2,$3,$4)", [
                conversationId, JSON.stringify({ text: fullText }), responseId, JSON.stringify(usage),
              ]);
              await query("UPDATE conversations SET last_response_id=$2 WHERE id=$1", [conversationId, responseId]);
            } catch {}
          }
          controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ responseId, usage })}\n\n`));
          controller.close();
        } catch (error) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`));
          controller.close();
        }
      },
      cancel() {
        const controller = (stream as unknown as { controller?: AbortController }).controller;
        controller?.abort();
      },
    });
    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return apiError(error, 400);
  }
}

async function prepareMovieFromScreenwriterAction(action: z.infer<typeof PrepareMovieAction>, userMessage: string, activeProjectId?: string) {
  const model = getVideoModel(action.modelId);
  const resolution = action.resolution as Resolution;
  if (!model.resolutions.includes(resolution)) throw new Error(`${resolution} is not supported by ${model.displayName}.`);
  const estimate = estimateGeneration({ durationSeconds: action.durationSeconds, modelId: action.modelId, resolution, renderTier: "draft" });
  let projectId = activeProjectId ?? action.projectId ?? undefined;
  if (!projectId) {
    const rows = await query<{ id: string }>(
      `INSERT INTO projects (workspace_id,title,prompt,duration_seconds,model_id,resolution,aspect_ratio,mode,render_tier,maximum_budget_usd,estimated_cost_usd,total_shots,status)
       VALUES ($1,'Screenwriter Movie',$2,$3,$4,$5,'16:9','quick','draft',0,$6,$7,'planning') RETURNING id`,
      [env().DEFAULT_WORKSPACE_ID, userMessage, action.durationSeconds, action.modelId, resolution, estimate.estimatedTotalUsd, estimate.shots],
    );
    projectId = rows[0].id;
  }
  let plan = await latestMoviePlan(projectId);
  const plannedModelId = plan?.scenes[0]?.shots[0]?.generationPrompt?.modelId;
  if (!plan || plan.summary.durationSeconds !== action.durationSeconds || plannedModelId !== action.modelId) {
    const rawPlan = await generateStructuredMoviePlan({ projectId, idea: userMessage, durationSeconds: action.durationSeconds, videoModelId: action.modelId, fastDraft: true });
    plan = adaptMoviePlanPrompts(rawPlan, action.modelId);
    await persistMoviePlan(plan);
    await query("UPDATE projects SET title=$2,model_id=$3,resolution=$4,duration_seconds=$5,estimated_cost_usd=$6,total_shots=$7 WHERE id=$1", [
      projectId, plan.summary.title, action.modelId, resolution, action.durationSeconds, estimate.estimatedTotalUsd, estimate.shots,
    ]);
  }
  return {
    projectId,
    title: plan.summary.title,
    durationSeconds: action.durationSeconds,
    modelId: action.modelId,
    resolution,
    shots: plan.scenes.reduce((sum, scene) => sum + scene.shots.length, 0),
    estimate,
    requiresPaidConfirmation: true,
  };
}
