import "server-only";
import { Queue } from "bullmq";
import { createHash } from "node:crypto";
import type { PlannedJob } from "./job-planner";
import { env } from "@/server/env";
import { query, transaction } from "@/server/db";

export const MOVIE_QUEUE = "cineforge-movie-generation";

export function redisConnection() {
  const url = new URL(env().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
  };
}

let queue: Queue | undefined;

export function movieQueue(): Queue {
  queue ??= new Queue(MOVIE_QUEUE, { connection: redisConnection(), defaultJobOptions: { removeOnComplete: 500, removeOnFail: 1_000 } });
  return queue;
}

export async function enqueueJobs(jobs: PlannedJob[]): Promise<number> {
  let added = 0;
  for (const job of jobs) {
    const result = await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO jobs (project_id, scene_id, shot_id, type, state, idempotency_key, priority, payload)
         VALUES ($1,$2,$3,$4,'queued',$5,$6,$7)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [job.projectId, job.sceneId, job.shotId, job.type, job.idempotencyKey, job.priority, JSON.stringify(job.payload)],
      );
      return inserted.rows[0]?.id ?? null;
    });
    if (!result) continue;
    const bullId = createHash("sha256").update(job.idempotencyKey).digest("hex");
    await movieQueue().add(job.type, { databaseJobId: result }, { jobId: bullId, priority: Math.max(1, 20_000 - job.priority) });
    added += 1;
  }
  return added;
}

export async function recoverInterruptedJobs(): Promise<number> {
  const rows = await query<{ id: string; type: string; idempotency_key: string }>(
    `UPDATE jobs SET state='queued', available_at=now(), last_error=jsonb_build_object('code','WORKER_RESTART','message','Recovered after worker restart')
     WHERE state IN ('generating','validating','retrying') RETURNING id, type, idempotency_key`,
  );
  for (const row of rows) {
    const bullId = createHash("sha256").update(`${row.idempotency_key}:recovery`).digest("hex");
    await movieQueue().add(row.type, { databaseJobId: row.id }, { jobId: bullId });
  }
  return rows.length;
}

export async function requeueDatabaseJob(input: { databaseJobId: string; attempt: number; delayMs: number; type?: string }): Promise<void> {
  const retryIdentity = `${input.databaseJobId}:attempt:${input.attempt}`;
  const bullId = createHash("sha256").update(retryIdentity).digest("hex");
  await movieQueue().add(input.type ?? "generate-shot", { databaseJobId: input.databaseJobId }, {
    jobId: bullId,
    delay: Math.max(0, input.delayMs),
  });
}

export async function pauseProjectJobs(projectId: string, reason: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE jobs SET state='paused', last_error=$2 WHERE project_id=$1 AND state IN ('planned','queued','retrying');
     UPDATE projects SET status='paused', last_error=$2 WHERE id=$1`,
    [projectId, JSON.stringify(reason)],
  );
}

export async function resumeProjectJobs(projectId: string): Promise<number> {
  const rows = await query<{ id: string; type: string; idempotency_key: string }>(
    `UPDATE jobs SET state='queued',available_at=now(),last_error=NULL
     WHERE project_id=$1 AND state IN ('paused','retrying') AND attempt < max_attempts
     RETURNING id,type,idempotency_key`,
    [projectId],
  );
  for (const row of rows) {
    const bullId = createHash("sha256").update(`${row.idempotency_key}:resume:${Date.now()}`).digest("hex");
    await movieQueue().add(row.type, { databaseJobId: row.id }, { jobId: bullId });
  }
  await query("UPDATE projects SET status=CASE WHEN completed_shots>0 THEN 'generating'::project_status ELSE 'queued'::project_status END,last_error=NULL WHERE id=$1", [projectId]);
  return rows.length;
}

export async function enqueueDialoguePatch(input: {
  projectId: string;
  sceneId: string;
  shotId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO jobs (project_id,scene_id,shot_id,type,state,idempotency_key,priority,payload)
     VALUES ($1,$2,$3,'dialogue-patch','queued',$4,10000,$5)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`,
    [input.projectId, input.sceneId, input.shotId, input.idempotencyKey, JSON.stringify(input.payload)],
  );
  const id = rows[0].id;
  await movieQueue().add("dialogue-patch", { databaseJobId: id }, { jobId: createHash("sha256").update(input.idempotencyKey).digest("hex") });
  return id;
}

export async function enqueueAssembly(input: {
  projectId: string;
  format: "mp4" | "mov";
  resolution: "720p" | "1080p" | "4k";
}): Promise<{ exportId: string; jobId: string }> {
  return transaction(async (client) => {
    const versions = await client.query<{ versions: string }>(
      "SELECT string_agg(id::text,',' ORDER BY created_at) versions FROM shot_versions WHERE active=true AND shot_id IN (SELECT id FROM shots WHERE project_id=$1)",
      [input.projectId],
    );
    const key = `assemble:${input.projectId}:${input.format}:${createHash("sha256").update(versions.rows[0]?.versions ?? "").digest("hex")}`;
    const exportRow = await client.query<{ id: string }>(
      "INSERT INTO exports (project_id,format,state) VALUES ($1,$2,'queued') RETURNING id",
      [input.projectId, input.format],
    );
    const job = await client.query<{ id: string }>(
      `INSERT INTO jobs (project_id,type,state,idempotency_key,priority,payload)
       VALUES ($1,'assemble-movie','queued',$2,1,$3)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`,
      [input.projectId, key, JSON.stringify({ ...input, exportId: exportRow.rows[0].id })],
    );
    await movieQueue().add("assemble-movie", { databaseJobId: job.rows[0].id }, { jobId: createHash("sha256").update(key).digest("hex") });
    return { exportId: exportRow.rows[0].id, jobId: job.rows[0].id };
  });
}
