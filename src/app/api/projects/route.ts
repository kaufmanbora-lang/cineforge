import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/server/env";
import { apiError } from "@/server/http";
import { query } from "@/server/db";
import { latestMoviePlan, listProjects } from "@/server/movie/repository";
import { estimateGeneration } from "@/domain/estimation";
import { getVideoModel, type Resolution } from "@/domain/video-models";
import { assertRateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";

const CreateProjectBody = z.object({
  title: z.string().min(1).max(200).default("Untitled movie"),
  prompt: z.string().min(10).max(20_000),
  durationSeconds: z.number().int().min(1).max(3_600),
  modelId: z.string(),
  resolution: z.enum(["preview", "720p", "1080p", "4k"]),
  aspectRatio: z.enum(["16:9", "9:16"]),
  mode: z.enum(["quick", "advanced"]).default("quick"),
  renderTier: z.enum(["draft", "final"]).default("draft"),
  maximumBudgetUsd: z.number().min(0).max(100_000),
});

const UpdateMemoryBody = z.discriminatedUnion("resourceKind", [
  z.object({
    projectId: z.string().uuid(),
    resourceKind: z.literal("character"),
    resourceId: z.string().min(1),
    locks: z.object({ appearance: z.boolean(), voice: z.boolean(), outfit: z.boolean() }),
  }),
  z.object({
    projectId: z.string().uuid(),
    resourceKind: z.literal("location"),
    resourceId: z.string().min(1),
    locks: z.object({ design: z.boolean() }),
  }),
]);

export async function GET(request: Request) {
  try {
    const projects = await listProjects(env().DEFAULT_WORKSPACE_ID);
    const projectId = new URL(request.url).searchParams.get("id");
    if (!projectId) return NextResponse.json({ projects });
    const project = projects.find((item) => item.id === projectId);
    if (!project) return NextResponse.json({ error: "Проект не найден." }, { status: 404 });
    const [plan, jobs, checkpoints, timeline, versions, exports, characters, locations] = await Promise.all([
      latestMoviePlan(projectId),
      query("SELECT id,type,state,scene_id,shot_id,attempt,max_attempts,last_error,created_at,updated_at,started_at,completed_at FROM jobs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 500", [projectId]),
      query("SELECT sequence,event_type,completed_shot_ids,failed_shot_ids,pending_shot_ids,current_job_id,created_at FROM checkpoints WHERE project_id=$1 ORDER BY sequence DESC LIMIT 100", [projectId]),
      query("SELECT id,scene_id,shot_id,track,start_seconds,duration_seconds,source_version,metadata FROM timeline_clips WHERE project_id=$1 AND enabled=true ORDER BY start_seconds,track", [projectId]),
      query("SELECT sv.shot_id,sv.version,sv.reason,sv.continuity_score,sv.qc_report,sv.active,sv.created_at FROM shot_versions sv JOIN shots s ON s.id=sv.shot_id WHERE s.project_id=$1 ORDER BY sv.created_at DESC", [projectId]),
      query("SELECT id,format,state,qc_report,created_at,completed_at FROM exports WHERE project_id=$1 ORDER BY created_at DESC", [projectId]),
      query("SELECT id,name,bible,current_state,locks FROM characters WHERE project_id=$1 ORDER BY name", [projectId]),
      query("SELECT id,name,bible,current_state,locks FROM locations WHERE project_id=$1 ORDER BY name", [projectId]),
    ]);
    return NextResponse.json({ project, plan, jobs, checkpoints, timeline, versions, exports, memory: { characters, locations } });
  } catch (error) {
    return NextResponse.json({ projects: [], infrastructure: "offline", error: error instanceof Error ? error.message : String(error) });
  }
}

export async function PATCH(request: Request) {
  try {
    assertRateLimit(request, "project memory", 60, 60_000);
    const body = UpdateMemoryBody.parse(await request.json());
    const table = body.resourceKind === "character" ? "characters" : "locations";
    const result = await query<{ id: string }>(
      `UPDATE ${table} resource SET locks=$4
       FROM projects project
       WHERE resource.id=$1 AND resource.project_id=$2 AND project.id=resource.project_id AND project.workspace_id=$3
       RETURNING resource.id`,
      [body.resourceId, body.projectId, env().DEFAULT_WORKSPACE_ID, JSON.stringify(body.locks)],
    );
    if (!result[0]) return NextResponse.json({ error: "Элемент памяти проекта не найден." }, { status: 404 });
    return NextResponse.json({ saved: true, locks: body.locks });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function POST(request: Request) {
  try {
    assertRateLimit(request, "project creation", 12, 60_000);
    const body = CreateProjectBody.parse(await request.json());
    const model = getVideoModel(body.modelId);
    if (!model.resolutions.includes(body.resolution as Resolution)) {
      return NextResponse.json({ error: `Модель ${model.displayName} не поддерживает разрешение ${body.resolution}.` }, { status: 400 });
    }
    const estimate = estimateGeneration({ durationSeconds: body.durationSeconds, modelId: body.modelId, resolution: body.resolution, renderTier: body.renderTier });
    const rows = await query<{ id: string }>(
      `INSERT INTO projects (workspace_id,title,prompt,duration_seconds,model_id,resolution,aspect_ratio,mode,render_tier,maximum_budget_usd,estimated_cost_usd,total_shots)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [env().DEFAULT_WORKSPACE_ID, body.title, body.prompt, body.durationSeconds, body.modelId, body.resolution,
        body.aspectRatio, body.mode, body.renderTier, body.maximumBudgetUsd, estimate.estimatedTotalUsd, estimate.shots],
    );
    return NextResponse.json({ projectId: rows[0].id, estimate }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}
