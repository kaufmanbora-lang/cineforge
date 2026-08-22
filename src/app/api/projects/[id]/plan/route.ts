import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { query } from "@/server/db";
import { generateStructuredMoviePlan } from "@/server/providers/openai";
import { latestMoviePlan, persistMoviePlan } from "@/server/movie/repository";
import { adaptMoviePlanPrompts } from "@/server/providers/video/prompt-adapters";
import { estimateGeneration } from "@/domain/estimation";
import type { Resolution } from "@/domain/video-models";
import { planGenerationJobs } from "@/server/movie/job-planner";
import { enqueueJobs, resumeProjectJobs } from "@/server/movie/queue";

export const runtime = "nodejs";
export const maxDuration = 800;

const Body = z.object({
  startGeneration: z.boolean().default(false),
  confirmed: z.boolean().default(false),
  maximumBudgetUsd: z.number().min(0).max(100_000).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let projectId: string | null = null;
  let stage = "planning";
  try {
    const { id } = await context.params;
    projectId = id;
    const body = Body.parse(await request.json().catch(() => ({})));
    if (body.startGeneration && !body.confirmed) {
      return NextResponse.json({ error: "Подтвердите расчёт стоимости перед запуском платной генерации." }, { status: 400 });
    }
    const rows = await query<{ prompt: string; duration_seconds: number; model_id: string; resolution: Resolution; render_tier: "draft" | "final"; maximum_budget_usd: string }>(
      "SELECT prompt,duration_seconds,model_id,resolution,render_tier,maximum_budget_usd FROM projects WHERE id=$1",
      [id],
    );
    if (!rows[0]) return NextResponse.json({ error: "Проект не найден." }, { status: 404 });
    const maximumBudget = body.maximumBudgetUsd ?? Number(rows[0].maximum_budget_usd);
    const estimate = estimateGeneration({ durationSeconds: rows[0].duration_seconds, modelId: rows[0].model_id, resolution: rows[0].resolution });
    if (body.startGeneration && estimate.estimatedTotalUsd > maximumBudget) {
      return NextResponse.json({ error: "Расчётная стоимость генерации превышает бюджет проекта.", estimate, maximumBudget }, { status: 409 });
    }

    let plan = await latestMoviePlan(id);
    if (!plan) {
      await query("UPDATE projects SET status='planning',last_error=NULL,updated_at=now() WHERE id=$1", [id]);
      const rawPlan = await generateStructuredMoviePlan({ projectId: id, idea: rows[0].prompt, durationSeconds: rows[0].duration_seconds });
      plan = adaptMoviePlanPrompts(rawPlan, rows[0].model_id);
      await persistMoviePlan(plan);
    }
    const shots = plan.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);
    let queued = 0;
    if (body.startGeneration) {
      stage = "queueing";
      queued = await enqueueJobs(planGenerationJobs(id, plan.scenes, { fastDraft: rows[0].render_tier === "draft" }));
      if (!queued) {
        const recoverable = await query<{ count: number }>(
          "SELECT count(*)::int count FROM jobs WHERE project_id=$1 AND state IN ('paused','retrying','failed') AND attempt < max_attempts",
          [id],
        );
        if (recoverable[0]?.count) queued = await resumeProjectJobs(id);
      }
      await query(
        "UPDATE projects SET title=$2,status=CASE WHEN status IN ('completed','cancelled') THEN status ELSE 'queued'::project_status END,maximum_budget_usd=$3,estimated_cost_usd=$4,last_error=NULL,updated_at=now() WHERE id=$1",
        [id, plan.summary.title, maximumBudget, estimate.estimatedTotalUsd],
      );
    } else {
      await query("UPDATE projects SET title=$2,status='planned',last_error=NULL,updated_at=now() WHERE id=$1", [id, plan.summary.title]);
    }
    return NextResponse.json({ plan, scenes: plan.scenes.length, shots, queued, estimate, projectId: id });
  } catch (error) {
    if (projectId) {
      await query("UPDATE projects SET status='failed',last_error=$2,updated_at=now() WHERE id=$1", [projectId, JSON.stringify({ stage, message: error instanceof Error ? error.message : String(error) })]).catch(() => []);
    }
    return apiError(error);
  }
}
