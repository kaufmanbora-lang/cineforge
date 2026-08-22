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
  queue ??= new Queue(MOVIE_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000,
    },
  });
  return queue;
}

export async function enqueueProjectPlanningJob(input: { projectId: string; maximumBudgetUsd: number }): Promise<string> {
  const idempotencyKey = `plan-project:${input.projectId}`;
  const rows = await query<{ id: string; state: string; attempt: number }>(
    `INSERT INTO jobs (project_id,type,state,idempotency_key,priority,payload,max_attempts)
     VALUES ($1,'plan-project','queued',$2,20000,$3,3)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       payload=EXCLUDED.payload,
       state=CASE WHEN jobs.state IN ('failed','paused','cancelled') THEN 'queued'::job_state ELSE jobs.state END,
       attempt=CASE WHEN jobs.state IN ('failed','paused','cancelled') THEN 0 ELSE jobs.attempt END,
       last_error=CASE WHEN jobs.state IN ('failed','paused','cancelled') THEN NULL ELSE jobs.last_error END,
       available_at=now()
     RETURNING id,state,attempt`,
    [input.projectId, idempotencyKey, JSON.stringify({ maximumBudgetUsd: input.maximumBudgetUsd })],
  );
  const row = rows[0];
  if (row.state === "queued") {
    const runIdentity = `${idempotencyKey}:attempt:${row.attempt}`;
    await movieQueue().add("plan-project", { databaseJobId: row.id }, {
      jobId: createHash("sha256").update(runIdentity).digest("hex"),
      priority: 1,
    });
  }
  return row.id;
}

export async function enqueueJobs(jobs: PlannedJob[]): Promise<number> {
  let added = 0;
  const settingRows = await query<{ settings: { automaticRetries?: number } }>("SELECT settings FROM workspace_settings WHERE workspace_id=$1", [env().DEFAULT_WORKSPACE_ID]).catch(() => []);
  const maxAttempts = Math.max(1, Math.min(6, Number(settingRows[0]?.settings.automaticRetries ?? env().MAX_AUTO_RETRIES) + 1));
  const projectIds = [...new Set(jobs.map((job) => job.projectId))];
  const completedRows = projectIds.length ? await query<{ project_id: string; id: string }>("SELECT project_id,id FROM shots WHERE project_id=ANY($1::uuid[]) AND state='completed'", [projectIds]) : [];
  const completedByProject = new Map(projectIds.map((id) => [id, new Set(completedRows.filter((row) => row.project_id === id).map((row) => row.id))]));
  for (const job of jobs) {
    const ready = job.dependencies.every((id) => completedByProject.get(job.projectId)?.has(id));
    const result = await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO jobs (project_id, scene_id, shot_id, type, state, idempotency_key, priority, payload, max_attempts)
         VALUES ($1,$2,$3,$4,$8,$5,$6,$7,$9)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [job.projectId, job.sceneId, job.shotId, job.type, job.idempotencyKey, job.priority, JSON.stringify(job.payload), ready ? "queued" : "planned", maxAttempts],
      );
      if (inserted.rows[0]) return { id: inserted.rows[0].id, enqueue: ready };

      const existing = await client.query<{ id: string; state: string }>(
        "SELECT id,state FROM jobs WHERE idempotency_key=$1 FOR UPDATE",
        [job.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row || row.state !== "planned") return { id: null, enqueue: false };
      await client.query(
        "UPDATE jobs SET payload=$2,priority=$3,max_attempts=$4,state=$5,available_at=now() WHERE id=$1",
        [row.id, JSON.stringify(job.payload), job.priority, maxAttempts, ready ? "queued" : "planned"],
      );
      return { id: row.id, enqueue: ready };
    });
    if (!result.id || !result.enqueue) continue;
    const bullId = createHash("sha256").update(job.idempotencyKey).digest("hex");
    await movieQueue().add(job.type, { databaseJobId: result.id }, { jobId: bullId, priority: Math.max(1, 20_000 - job.priority) });
    added += 1;
  }
  return added;
}

export async function enqueueReadyProjectJobs(projectId: string): Promise<number> {
  const ready = await transaction(async (client) => {
    const completed = await client.query<{ id: string }>("SELECT id FROM shots WHERE project_id=$1 AND state='completed'", [projectId]);
    const completedIds = new Set(completed.rows.map((row) => row.id));
    const planned = await client.query<{ id: string; type: string; idempotency_key: string; priority: number; payload: { shot?: { dependencies?: string[] } } }>(
      "SELECT id,type,idempotency_key,priority,payload FROM jobs WHERE project_id=$1 AND state='planned' ORDER BY priority DESC FOR UPDATE",
      [projectId],
    );
    const rows = planned.rows.filter((job) => (job.payload.shot?.dependencies ?? []).every((id) => completedIds.has(id)));
    if (rows.length) await client.query("UPDATE jobs SET state='queued',available_at=now() WHERE id=ANY($1::uuid[])", [rows.map((row) => row.id)]);
    return rows;
  });
  for (const row of ready) {
    await movieQueue().add(row.type, { databaseJobId: row.id }, {
      jobId: createHash("sha256").update(row.idempotency_key).digest("hex"),
      priority: Math.max(1, 20_000 - row.priority),
    });
  }
  return ready.length;
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

export async function reconcileQueuedJobs(): Promise<number> {
  const rows = await query<{ id: string; type: string; idempotency_key: string; priority: number }>(
    `SELECT j.id,j.type,j.idempotency_key,j.priority FROM jobs j
     JOIN projects p ON p.id=j.project_id
     WHERE j.state='queued' AND j.available_at<=now()
       AND p.status IN ('planning','queued','generating','validating','assembling')`,
  );
  const bucket = Math.floor(Date.now() / 30_000);
  for (const row of rows) {
    const bullId = createHash("sha256").update(`${row.idempotency_key}:reconcile:${bucket}`).digest("hex");
    await movieQueue().add(row.type, { databaseJobId: row.id }, { jobId: bullId, priority: Math.max(1, 20_000 - row.priority) });
  }
  return rows.length;
}

export async function recoverStaleJobs(): Promise<number> {
  // Google documents an upper bound of minutes for ordinary video requests.
  // A job left in an active state for twelve minutes without an update is an
  // orphan (for example, the database restarted while BullMQ was handling it).
  // The atomic claim in processShot prevents duplicate paid calls.
  const rows = await query<{ id: string; type: string; idempotency_key: string; priority: number }>(
    `UPDATE jobs j SET state='queued',available_at=now(),started_at=NULL,
       last_error=jsonb_build_object('code','STALE_JOB_RECOVERY','message','Recovered an orphaned generation job'),updated_at=now()
     FROM projects p
     WHERE j.project_id=p.id AND j.state IN ('generating','validating','retrying')
       AND j.updated_at < now() - interval '12 minutes'
       AND p.status IN ('planning','queued','generating','validating','assembling')
     RETURNING j.id,j.type,j.idempotency_key,j.priority`,
  );
  for (const row of rows) {
    const bullId = createHash("sha256").update(`${row.idempotency_key}:stale:${Date.now()}`).digest("hex");
    await movieQueue().add(row.type, { databaseJobId: row.id }, { jobId: bullId, priority: Math.max(1, 20_000 - row.priority) });
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
  await transaction(async (client) => {
    await client.query(
      "UPDATE jobs SET state='paused',last_error=$2 WHERE project_id=$1 AND state IN ('planned','queued','retrying')",
      [projectId, JSON.stringify(reason)],
    );
    await client.query("UPDATE projects SET status='paused',last_error=$2 WHERE id=$1", [projectId, JSON.stringify(reason)]);
  });
}

export async function resumeProjectJobs(projectId: string): Promise<number> {
  const rows = await transaction(async (client) => {
    const completed = await client.query<{ id: string }>("SELECT id FROM shots WHERE project_id=$1 AND state='completed'", [projectId]);
    const completedIds = new Set(completed.rows.map((row) => row.id));
    const candidates = await client.query<{ id: string; type: string; idempotency_key: string; state: string; attempt: number; max_attempts: number; payload: { shot?: { dependencies?: string[] } } }>(
      `SELECT id,type,idempotency_key,state,attempt,max_attempts,payload FROM jobs
       WHERE project_id=$1 AND state IN ('paused','retrying','failed')
         AND (attempt < max_attempts OR (state='failed' AND COALESCE(last_error->>'message','') ~* 'ECONNREFUSED|connection refused'))
       FOR UPDATE`,
      [projectId],
    );
    const ready = candidates.rows.filter((job) => job.type !== "generate-shot" || (job.payload.shot?.dependencies ?? []).every((id) => completedIds.has(id)));
    const waiting = candidates.rows.filter((job) => !ready.includes(job));
    if (ready.length) await client.query("UPDATE jobs SET state='queued',attempt=CASE WHEN attempt>=max_attempts THEN 0 ELSE attempt END,available_at=now(),last_error=NULL WHERE id=ANY($1::uuid[])", [ready.map((row) => row.id)]);
    if (waiting.length) await client.query("UPDATE jobs SET state='planned',attempt=CASE WHEN attempt>=max_attempts THEN 0 ELSE attempt END,available_at=now(),last_error=NULL WHERE id=ANY($1::uuid[])", [waiting.map((row) => row.id)]);
    return ready;
  });
  for (const row of rows) {
    const bullId = createHash("sha256").update(`${row.idempotency_key}:resume:${Date.now()}`).digest("hex");
    await movieQueue().add(row.type, { databaseJobId: row.id }, { jobId: bullId });
  }
  await query("UPDATE projects SET status=CASE WHEN completed_shots>0 THEN 'generating'::project_status ELSE 'queued'::project_status END,last_error=NULL WHERE id=$1", [projectId]);
  return rows.length + await enqueueReadyProjectJobs(projectId);
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
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
    const existing = await client.query<{ id: string; payload: { exportId?: string } }>("SELECT id,payload FROM jobs WHERE idempotency_key=$1", [key]);
    if (existing.rows[0]?.payload.exportId) return { exportId: existing.rows[0].payload.exportId, jobId: existing.rows[0].id };
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

export async function enqueueAutomaticAssemblyIfReady(projectId: string): Promise<boolean> {
  const rows = await query<{ resolution: "preview" | "720p" | "1080p" | "4k"; completed: number; total: number; active_audio: number; failed: number }>(
    `SELECT p.resolution,
       count(s.id) FILTER (WHERE s.state='completed')::int completed,
       count(s.id)::int total,
       (SELECT count(*)::int FROM jobs j WHERE j.project_id=p.id AND j.type='dialogue-patch' AND j.state NOT IN ('completed','cancelled')) active_audio,
       (SELECT count(*)::int FROM jobs j WHERE j.project_id=p.id AND j.state='failed' AND j.type IN ('generate-shot','dialogue-patch')) failed
     FROM projects p LEFT JOIN shots s ON s.project_id=p.id WHERE p.id=$1 GROUP BY p.id`,
    [projectId],
  );
  const state = rows[0];
  if (!state || !state.total || state.completed !== state.total || state.active_audio || state.failed) return false;
  await query("UPDATE projects SET status='assembling' WHERE id=$1 AND status NOT IN ('completed','cancelled')", [projectId]);
  await enqueueAssembly({ projectId, format: "mp4", resolution: state.resolution === "preview" ? "720p" : state.resolution });
  return true;
}
