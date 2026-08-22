import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/server/env";
import { apiError } from "@/server/http";
import { query } from "@/server/db";
import { listProjects } from "@/server/movie/repository";
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

export async function GET() {
  try {
    return NextResponse.json({ projects: await listProjects(env().DEFAULT_WORKSPACE_ID) });
  } catch (error) {
    return NextResponse.json({ projects: [], infrastructure: "offline", error: error instanceof Error ? error.message : String(error) });
  }
}

export async function POST(request: Request) {
  try {
    assertRateLimit(request, "project creation", 12, 60_000);
    const body = CreateProjectBody.parse(await request.json());
    const model = getVideoModel(body.modelId);
    if (!model.resolutions.includes(body.resolution as Resolution)) {
      return NextResponse.json({ error: `${body.resolution} is not supported by ${model.displayName}.` }, { status: 400 });
    }
    const estimate = estimateGeneration({ durationSeconds: body.durationSeconds, modelId: body.modelId, resolution: body.resolution });
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
