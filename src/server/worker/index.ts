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

await recoverInterruptedJobs();
await recoverActiveProjects();
await reconcileQueuedJobs();
const settingRows = await query<{ settings: { workerConcurrency?: number } }>("SELECT settings FROM workspace_settings WHERE workspace_id=$1", [env().DEFAULT_WORKSPACE_ID]).catch(() => []);
const workerConcurrency = Math.max(1, Math.min(16, Number(settingRows[0]?.settings.workerConcurrency ?? env().WORKER_CONCURRENCY)));

const worker = new Worker(
  MOVIE_QUEUE,
  async (job) => {
    const databaseJobId = String(job.data.databaseJobId);
    if (job.name === "dialogue-patch" || job.name === "assemble-movie") {
      try {
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
