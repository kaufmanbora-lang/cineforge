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
import { enqueueJobs, enqueueProjectPlanningJob, resumeProjectJobs } from "@/server/movie/queue";

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
    const estimate = estimateGeneration({ durationSeconds: rows[0].duration_seconds, modelId: rows[0].model_id, resolution: rows[0].resolution, renderTier: rows[0].render_tier });
    if (body.startGeneration && estimate.estimatedTotalUsd > maximumBudget) {
      return NextResponse.json({ error: "Расчётная стоимость генерации превышает бюджет проекта.", estimate, maximumBudget }, { status: 409 });
    }

    let plan = await latestMoviePlan(id);
    if (!plan && body.startGeneration) {
      stage = "queueing-plan";
      await query(
        "UPDATE projects SET status='planning',maximum_budget_usd=$2,estimated_cost_usd=$3,last_error=NULL,updated_at=now() WHERE id=$1",
        [id, maximumBudget, estimate.estimatedTotalUsd],
      );
      const planningJobId = await enqueueProjectPlanningJob({ projectId: id, maximumBudgetUsd: maximumBudget });
      return NextResponse.json({
        accepted: true,
        status: "planning",
        planningJobId,
        scenes: 0,
        shots: estimate.shots,
        queued: 0,
        estimate,
        projectId: id,
      }, { status: 202 });
    }
    if (!plan) {
      await query("UPDATE projects SET status='planning',last_error=NULL,updated_at=now() WHERE id=$1", [id]);
      const rawPlan = await generateStructuredMoviePlan({ projectId: id, idea: rows[0].prompt, durationSeconds: rows[0].duration_seconds, videoModelId: rows[0].model_id, fastDraft: rows[0].render_tier === "draft" });
      const adaptedPlan = adaptMoviePlanPrompts(rawPlan, rows[0].model_id);
      await persistMoviePlan(adaptedPlan);
      // Persistence scopes every graph ID to the project. Queue only the stored
      // canonical graph so its scene/shot foreign keys exactly match PostgreSQL.
      plan = await latestMoviePlan(id);
      if (!plan) throw new Error("Сохранённый план фильма не найден после записи.");
    }
    const shots = plan.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);
    let queued = 0;
    if (body.startGeneration) {
      stage = "queueing";
      // Publish the active project state before the queue envelope. Otherwise a
      // fast worker can pause or complete the project and this route would race
      // behind it, incorrectly overwriting the authoritative result with queued.
      await query(
        "UPDATE projects SET title=$2,status=CASE WHEN status IN ('completed','cancelled') THEN status ELSE 'queued'::project_status END,maximum_budget_usd=$3,estimated_cost_usd=$4,last_error=NULL,updated_at=now() WHERE id=$1",
        [id, plan.summary.title, maximumBudget, estimate.estimatedTotalUsd],
      );
      queued = await enqueueJobs(planGenerationJobs(id, plan.scenes, { fastDraft: rows[0].render_tier === "draft" }));
      if (!queued) {
        // Reaching this branch means the user explicitly confirmed production
        // again. Reset exhausted attempts and resume only unfinished jobs; the
        // completed shot versions remain immutable and are never regenerated.
        queued = await resumeProjectJobs(id, { manual: true });
      }
    } else {
      await query("UPDATE projects SET title=$2,status='planned',last_error=NULL,updated_at=now() WHERE id=$1", [id, plan.summary.title]);
    }
    return NextResponse.json({ plan, scenes: plan.scenes.length, shots, queued, estimate, projectId: id });
  } catch (error) {
    if (projectId) {
      const queueStage = stage === "queueing" || stage === "queueing-plan";
      if (queueStage) {
        // Queue rows are durable and the worker reconciler republishes missing
        // Redis envelopes. A transient queue connection must not convert a
        // safely stored production into a terminal failed project.
        const pending = await query<{ count: number }>(
          "SELECT count(*)::int count FROM jobs WHERE project_id=$1 AND state IN ('planned','queued','retrying','generating','validating')",
          [projectId],
        ).catch(() => []);
        if (Number(pending[0]?.count ?? 0) > 0) {
          const details = { code: "QUEUE_DELIVERY_DELAY", stage, message: "Задание сохранено. Фоновый обработчик продолжит его автоматически после восстановления очереди." };
          await query(
            "UPDATE projects SET status=CASE WHEN $2='queueing-plan' THEN 'planning'::project_status ELSE 'queued'::project_status END,last_error=NULL,updated_at=now() WHERE id=$1",
            [projectId, stage],
          ).catch(() => []);
          await query(
            "INSERT INTO checkpoints (project_id,event_type,snapshot) VALUES ($1,'queue-delivery-delayed',$2)",
            [projectId, JSON.stringify(details)],
          ).catch(() => []);
          return NextResponse.json({ accepted: true, projectId, queued: Number(pending[0]?.count ?? 0), warning: details.message }, { status: 202 });
        }
      }
      await query("UPDATE projects SET status='failed',last_error=$2,updated_at=now() WHERE id=$1", [projectId, JSON.stringify({ stage, message: error instanceof Error ? error.message : String(error) })]).catch(() => []);
    }
    return apiError(error);
  }
}
