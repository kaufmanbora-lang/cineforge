import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { query } from "@/server/db";
import { latestMoviePlan } from "@/server/movie/repository";
import { planGenerationJobs } from "@/server/movie/job-planner";
import { enqueueJobs } from "@/server/movie/queue";
import { estimateGeneration } from "@/domain/estimation";
import type { Resolution } from "@/domain/video-models";

export const runtime = "nodejs";

const Body = z.object({ confirmed: z.literal(true), maximumBudgetUsd: z.number().min(0).max(100_000).optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = Body.parse(await request.json());
    const rows = await query<{ duration_seconds: number; model_id: string; resolution: Resolution; maximum_budget_usd: string }>(
      "SELECT duration_seconds,model_id,resolution,maximum_budget_usd FROM projects WHERE id=$1",
      [id],
    );
    if (!rows[0]) return NextResponse.json({ error: "Проект не найден." }, { status: 404 });
    const maximumBudget = body.maximumBudgetUsd ?? Number(rows[0].maximum_budget_usd);
    const estimate = estimateGeneration({ durationSeconds: rows[0].duration_seconds, modelId: rows[0].model_id, resolution: rows[0].resolution });
    if (estimate.estimatedTotalUsd > maximumBudget) {
      return NextResponse.json({ error: "Расчётная стоимость генерации превышает бюджет проекта.", estimate, maximumBudget }, { status: 409 });
    }
    const plan = await latestMoviePlan(id);
    if (!plan) return NextResponse.json({ error: "Создайте сценарий и план фильма перед запуском генерации." }, { status: 409 });
    const added = await enqueueJobs(planGenerationJobs(id, plan.scenes));
    await query("UPDATE projects SET status='queued',maximum_budget_usd=$2,estimated_cost_usd=$3 WHERE id=$1", [id, maximumBudget, estimate.estimatedTotalUsd]);
    return NextResponse.json({ queued: added, estimate, projectId: id });
  } catch (error) {
    return apiError(error, 400);
  }
}
