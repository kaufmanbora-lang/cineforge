import { Worker } from "bullmq";
import { MOVIE_QUEUE, enqueueJobs, pauseProjectJobs, reconcileQueuedJobs, recoverInterruptedJobs, recoverStaleJobs, redisConnection, requeueDatabaseJob } from "@/server/movie/queue";
import { processShot } from "./process-shot";
import { processDialoguePatch } from "./process-dialogue";
import { processAssembly } from "./process-assembly";
import { env } from "@/server/env";
import { query } from "@/server/db";
import { classifyFailure, retryDecision } from "@/server/movie/retry";
import { latestMoviePlan } from "@/server/movie/repository";
import { planGenerationJobs } from "@/server/movie/job-planner";
import { generateStructuredMoviePlan } from "@/server/providers/openai";
import { adaptMoviePlanPrompts } from "@/server/providers/video/prompt-adapters";
import { persistMoviePlan } from "@/server/movie/repository";
import { estimateGeneration } from "@/domain/estimation";
import type { Resolution } from "@/domain/video-models";

await recoverInterruptedJobs();
await recoverActiveProjects();
await reconcileQueuedJobs();
const settingRows = await query<{ settings: { workerConcurrency?: number } }>("SELECT settings FROM workspace_settings WHERE workspace_id=$1", [env().DEFAULT_WORKSPACE_ID]).catch(() => []);
const workerConcurrency = Math.max(1, Math.min(16, Number(settingRows[0]?.settings.workerConcurrency ?? env().WORKER_CONCURRENCY)));

const worker = new Worker(
  MOVIE_QUEUE,
  async (job) => {
    const databaseJobId = String(job.data.databaseJobId);
    if (job.name === "plan-project" || job.name === "dialogue-patch" || job.name === "assemble-movie") {
      try {
        if (job.name === "plan-project") return await processProjectPlan(databaseJobId);
        return job.name === "dialogue-patch" ? await processDialoguePatch(databaseJobId) : await processAssembly(databaseJobId);
      } catch (error) {
        await handleBackgroundFailure(databaseJobId, job.name, error);
        throw error;
      }
    }
    try {
      return await processShot(databaseJobId);
    } catch (error) {
      await handleBackgroundFailure(databaseJobId, job.name, error).catch(() => undefined);
      throw error;
    }
  },
  { connection: redisConnection(), concurrency: workerConcurrency },
);
const reconciliationTimer = setInterval(() => {
  void Promise.all([reconcileQueuedJobs(), recoverStaleJobs()]).catch((error) => process.stderr.write(`Queue reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`));
}, 30_000);
reconciliationTimer.unref();

async function recoverActiveProjects() {
  const projects = await query<{ id: string; render_tier: "draft" | "final" }>(
    "SELECT id,render_tier FROM projects WHERE status IN ('queued','generating','validating','assembling')",
  );
  for (const project of projects) {
    const plan = await latestMoviePlan(project.id);
    if (!plan) continue;
    await enqueueJobs(planGenerationJobs(project.id, plan.scenes, { fastDraft: project.render_tier === "draft" }));
  }
}

async function processProjectPlan(databaseJobId: string) {
  const rows = await query<{
    id: string; project_id: string; payload: { maximumBudgetUsd?: number };
    prompt: string; duration_seconds: number; model_id: string; resolution: Resolution;
    render_tier: "draft" | "final"; maximum_budget_usd: string;
  }>(
    `WITH claimed AS (
       UPDATE jobs SET state='generating',started_at=now(),attempt=attempt+1,updated_at=now()
       WHERE id=$1 AND type='plan-project' AND state IN ('queued','retrying') AND available_at<=now()
       RETURNING *
     )
     SELECT claimed.*,p.prompt,p.duration_seconds,p.model_id,p.resolution,p.render_tier,p.maximum_budget_usd
     FROM claimed JOIN projects p ON p.id=claimed.project_id`,
    [databaseJobId],
  );
  const job = rows[0];
  if (!job) return { planned: false, queued: 0 };
  const heartbeat = setInterval(() => {
    void query("UPDATE jobs SET updated_at=now() WHERE id=$1 AND state='generating'", [job.id]).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  try {
    const maximumBudget = Number(job.payload.maximumBudgetUsd ?? job.maximum_budget_usd);
    const estimate = estimateGeneration({ durationSeconds: job.duration_seconds, modelId: job.model_id, resolution: job.resolution });
    if (estimate.estimatedTotalUsd > maximumBudget) {
      throw Object.assign(new Error("Расчётная стоимость генерации превышает максимальный бюджет проекта."), { status: 409, code: "BUDGET_REACHED" });
    }
    await query("UPDATE projects SET status='planning',last_error=NULL,updated_at=now() WHERE id=$1", [job.project_id]);
    let plan = await latestMoviePlan(job.project_id);
    if (!plan) {
      const rawPlan = await generateStructuredMoviePlan({ projectId: job.project_id, idea: job.prompt, durationSeconds: job.duration_seconds });
      await persistMoviePlan(adaptMoviePlanPrompts(rawPlan, job.model_id));
      plan = await latestMoviePlan(job.project_id);
      if (!plan) throw new Error("Сохранённый план фильма не найден после записи.");
    }
    await query(
      "UPDATE projects SET title=$2,status='queued',maximum_budget_usd=$3,estimated_cost_usd=$4,last_error=NULL,updated_at=now() WHERE id=$1",
      [job.project_id, plan.summary.title, maximumBudget, estimate.estimatedTotalUsd],
    );
    const queued = await enqueueJobs(planGenerationJobs(job.project_id, plan.scenes, { fastDraft: job.render_tier === "draft" }));
    await query("UPDATE jobs SET state='completed',result=$2,completed_at=now(),last_error=NULL WHERE id=$1", [
      job.id,
      JSON.stringify({ scenes: plan.scenes.length, shots: plan.scenes.reduce((sum, scene) => sum + scene.shots.length, 0), queued }),
    ]);
    return { planned: true, queued };
  } finally {
    clearInterval(heartbeat);
  }
}

async function handleBackgroundFailure(databaseJobId: string, type: string, error: unknown) {
  const rows = await query<{ id: string; project_id: string; attempt: number; max_attempts: number; state: string }>("SELECT id,project_id,attempt,max_attempts,state FROM jobs WHERE id=$1", [databaseJobId]);
  const job = rows[0];
  if (!job || job.state === "failed" || job.state === "paused" || job.state === "completed" || (type === "generate-shot" && job.state === "retrying")) return;
  const failure = classifyFailure(error);
  const decision = retryDecision({ failure, attempt: job.attempt, maxAttempts: job.max_attempts });
  const details = { failure, message: error instanceof Error ? error.message : String(error), jobType: type };
  if (decision.pauseProject) await pauseProjectJobs(job.project_id, details);
  await query(
    "UPDATE jobs SET state=$2,last_error=$3,available_at=now()+($4::text || ' milliseconds')::interval WHERE id=$1",
    [job.id, decision.pauseProject ? "paused" : decision.retry ? "retrying" : "failed", JSON.stringify(details), decision.delayMs],
  );
  if (decision.retry) await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: decision.delayMs, type });
  if (!decision.pauseProject && !decision.retry) await query("UPDATE projects SET status='failed',last_error=$2 WHERE id=$1", [job.project_id, JSON.stringify(details)]);
}

worker.on("completed", (job) => process.stdout.write(`Completed ${job.id}\n`));
worker.on("failed", (job, error) => process.stderr.write(`Failed ${job?.id}: ${error.message}\n`));

async function shutdown() {
  clearInterval(reconciliationTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
