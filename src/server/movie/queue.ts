import { Queue } from "bullmq";
import { createHash, randomUUID } from "node:crypto";
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
      // Database job state owns the bounded retry policy. BullMQ retries here
      // only duplicate an envelope; reconciliation restores lost envelopes.
      attempts: 1,
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
    const runIdentity = `${idempotencyKey}:attempt:${row.attempt}:envelope:${randomUUID()}`;
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
    // A completed shot is immutable until an edit explicitly marks that exact
    // shot planned again. Re-planning or pressing Generate must never revive an
    // obsolete failed job and overwrite a good active version.
    if (job.type === "generate-shot" && completedByProject.get(job.projectId)?.has(job.shotId)) continue;
    const ready = job.dependencies.every((id) => completedByProject.get(job.projectId)?.has(id));
    const result = await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO jobs (project_id, scene_id, shot_id, type, state, idempotency_key, priority, payload, max_attempts)
         VALUES ($1,$2,$3,$4,$8,$5,$6,$7,$9)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [job.projectId, job.sceneId, job.shotId, job.type, job.idempotencyKey, job.priority, JSON.stringify(job.payload), ready ? "queued" : "planned", maxAttempts],
      );
      if (inserted.rows[0]) return { id: inserted.rows[0].id, enqueue: ready, existing: false };

      const existing = await client.query<{ id: string; state: string }>(
        "SELECT id,state FROM jobs WHERE idempotency_key=$1 FOR UPDATE",
        [job.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row || row.state === "completed" || row.state === "generating" || row.state === "validating") return { id: null, enqueue: false, existing: true };
      if (!["planned", "failed", "paused", "cancelled", "retrying", "queued"].includes(row.state)) return { id: null, enqueue: false, existing: true };
      await client.query(
        "UPDATE jobs SET payload=$2,priority=$3,max_attempts=$4,state=$5,attempt=CASE WHEN state IN ('failed','paused','cancelled') THEN 0 ELSE attempt END,last_error=NULL,available_at=now(),updated_at=now() WHERE id=$1",
        [row.id, JSON.stringify(job.payload), job.priority, maxAttempts, ready ? "queued" : "planned"],
      );
      return { id: row.id, enqueue: ready, existing: true };
    });
    if (!result.id || !result.enqueue) continue;
    const bullId = createHash("sha256").update(result.existing ? `${job.idempotencyKey}:envelope:${randomUUID()}` : job.idempotencyKey).digest("hex");
    await movieQueue().add(job.type, { databaseJobId: result.id }, { jobId: bullId, priority: Math.max(1, 20_000 - job.priority) });
    added += 1;
  }
  return added;
}

export async function enqueueReadyProjectJobs(projectId: string): Promise<number> {
  const ready = await transaction(async (client) => {
    const project = await client.query<{ status: string }>("SELECT status FROM projects WHERE id=$1 FOR UPDATE", [projectId]);
    if (!project.rows[0] || ["paused", "failed", "cancelled", "completed"].includes(project.rows[0].status)) return [];
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
      jobId: createHash("sha256").update(`${row.idempotency_key}:ready:${randomUUID()}`).digest("hex"),
      priority: Math.max(1, 20_000 - row.priority),
    });
  }
  return ready.length;
}

export async function recoverInterruptedJobs(): Promise<number> {
  const rows = await query<{ id: string; type: string; idempotency_key: string }>(
    `UPDATE jobs j SET state='queued', available_at=now(), last_error=jsonb_build_object('code','WORKER_RESTART','message','Recovered after worker restart')
     FROM projects p
     WHERE j.project_id=p.id
       AND j.state IN ('generating','validating','retrying')
       AND p.status IN ('planning','queued','generating','validating','assembling')
       AND j.updated_at < now() - CASE WHEN j.type IN ('generate-shot','plan-project') THEN interval '2 minutes' ELSE interval '12 minutes' END
     RETURNING j.id, j.type, j.idempotency_key`,
  );
  for (const row of rows) {
    const bullId = createHash("sha256").update(`${row.idempotency_key}:recovery:${randomUUID()}`).digest("hex");
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
  // Video and planning jobs publish frequent heartbeats, so two minutes of
  // silence proves their worker lease is gone. FFmpeg/audio jobs get a longer
  // window because their native subprocesses can legitimately stay quiet.
  const rows = await query<{ id: string; type: string; idempotency_key: string; priority: number }>(
    `UPDATE jobs j SET state='queued',available_at=now(),started_at=NULL,
       last_error=jsonb_build_object('code','STALE_JOB_RECOVERY','message','Recovered an orphaned generation job'),updated_at=now()
     FROM projects p
     WHERE j.project_id=p.id AND j.state IN ('generating','validating','retrying')
       AND j.updated_at < now() - CASE WHEN j.type IN ('generate-shot','plan-project') THEN interval '2 minutes' ELSE interval '12 minutes' END
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
  // Manual resume may reset the database attempt counter. A stable BullMQ ID
  // would then point at an old retained envelope and silently skip the retry.
  // Each envelope is unique; the atomic database claim still guarantees that
  // at most one worker can execute the paid generation job.
  const bullId = retryEnvelopeJobId(input.databaseJobId, input.attempt, randomUUID());
  await movieQueue().add(input.type ?? "generate-shot", { databaseJobId: input.databaseJobId }, {
    jobId: bullId,
    delay: Math.max(0, input.delayMs),
  });
}

export function retryEnvelopeJobId(databaseJobId: string, attempt: number, nonce: string): string {
  return createHash("sha256").update(`${databaseJobId}:attempt:${attempt}:retry:${nonce}`).digest("hex");
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

export async function resumeProjectJobs(projectId: string, options: { manual?: boolean } = {}): Promise<number> {
  const rows = await transaction(async (client) => {
    const project = await client.query<{ status: string }>("SELECT status FROM projects WHERE id=$1 FOR UPDATE", [projectId]);
    if (!project.rows[0] || ["completed", "cancelled"].includes(project.rows[0].status)) return [];
    const completed = await client.query<{ id: string }>("SELECT id FROM shots WHERE project_id=$1 AND state='completed'", [projectId]);
    const completedIds = new Set(completed.rows.map((row) => row.id));
    const candidates = await client.query<{ id: string; type: string; idempotency_key: string; state: string; attempt: number; max_attempts: number; payload: { shot?: { dependencies?: string[] } } }>(
      `SELECT j.id,j.type,j.idempotency_key,j.state,j.attempt,j.max_attempts,j.payload FROM jobs j
       LEFT JOIN shots sh ON sh.id=j.shot_id
       WHERE j.project_id=$1 AND j.state IN ('paused','retrying','failed')
         AND (j.type <> 'generate-shot' OR sh.state <> 'completed')
         AND (
           j.attempt < j.max_attempts
           OR $2::boolean
           OR (
             j.state='failed'
             AND COALESCE(j.last_error->>'message','') ~* 'ECONNREFUSED|connection refused|previous_interaction_id is not allowed when video task is set'
           )
         )
       FOR UPDATE OF j`,
      [projectId, Boolean(options.manual)],
    );
    const ready = candidates.rows.filter((job) => job.type !== "generate-shot" || (job.payload.shot?.dependencies ?? []).every((id) => completedIds.has(id)));
    const waiting = candidates.rows.filter((job) => !ready.includes(job));
    if (ready.length) await client.query("UPDATE jobs SET state='queued',attempt=CASE WHEN attempt>=max_attempts THEN 0 ELSE attempt END,available_at=now(),last_error=NULL WHERE id=ANY($1::uuid[])", [ready.map((row) => row.id)]);
    if (waiting.length) await client.query("UPDATE jobs SET state='planned',attempt=CASE WHEN attempt>=max_attempts THEN 0 ELSE attempt END,available_at=now(),last_error=NULL WHERE id=ANY($1::uuid[])", [waiting.map((row) => row.id)]);
    if (ready.length || waiting.length) {
      await client.query(
        "UPDATE projects SET status=$2::project_status,last_error=NULL,updated_at=now() WHERE id=$1 AND status NOT IN ('completed','cancelled')",
        [projectId, completedIds.size > 0 ? "generating" : "queued"],
      );
    }
    return ready;
  });
  for (const row of rows) {
    const bullId = createHash("sha256").update(`${row.idempotency_key}:resume:${randomUUID()}`).digest("hex");
    await movieQueue().add(row.type, { databaseJobId: row.id }, { jobId: bullId });
  }
  const resumed = rows.length + await enqueueReadyProjectJobs(projectId);
  // A project may contain every generated shot but have a failed/stale assembly
  // job. Resume must finish the free local assembly instead of returning zero
  // and leaving the UI at 100% with a terminal error.
  if (!resumed) await enqueueAutomaticAssemblyIfReady(projectId);
  return resumed;
}

export async function recoverCompletedShotProjects(): Promise<number> {
  const rows = await query<{ id: string }>(
    `SELECT p.id FROM projects p
     WHERE p.status IN ('paused','failed','generating','validating','assembling')
       AND COALESCE(p.last_error->>'code','') <> 'FINAL_QC_FAILED'
       AND EXISTS (SELECT 1 FROM shots s WHERE s.project_id=p.id AND s.state<>'cancelled')
       AND NOT EXISTS (SELECT 1 FROM shots s WHERE s.project_id=p.id AND s.state NOT IN ('completed','cancelled'))
       AND NOT EXISTS (
         SELECT 1 FROM jobs j WHERE j.project_id=p.id AND j.type='assemble-movie' AND j.state='failed'
           AND (j.attempt>=j.max_attempts OR COALESCE(j.last_error->>'code','')='FINAL_QC_FAILED')
       )
       AND NOT EXISTS (
         SELECT 1 FROM jobs j WHERE j.project_id=p.id AND j.type='dialogue-patch'
           AND j.state IN ('planned','queued','retrying','generating','validating')
       )`,
  );
  let recovered = 0;
  for (const row of rows) {
    if (await enqueueAutomaticAssemblyIfReady(row.id)) recovered += 1;
  }
  return recovered;
}

export async function enqueueDialoguePatch(input: {
  projectId: string;
  sceneId: string;
  shotId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ jobId: string; queued: boolean; state: string }> {
  const row = await transaction(async (client) => {
    const rows = await client.query<{ id: string; state: string }>(
      `INSERT INTO jobs (project_id,scene_id,shot_id,type,state,idempotency_key,priority,payload)
       VALUES ($1,$2,$3,'dialogue-patch','queued',$4,10000,$5)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         payload=EXCLUDED.payload,
         state=CASE WHEN jobs.state IN ('failed','paused','cancelled') THEN 'queued'::job_state ELSE jobs.state END,
         attempt=CASE WHEN jobs.state IN ('failed','paused','cancelled') THEN 0 ELSE jobs.attempt END,
         last_error=CASE WHEN jobs.state IN ('failed','paused','cancelled') THEN NULL ELSE jobs.last_error END,
         available_at=CASE WHEN jobs.state IN ('failed','paused','cancelled') THEN now() ELSE jobs.available_at END
       RETURNING id,state`,
      [input.projectId, input.sceneId, input.shotId, input.idempotencyKey, JSON.stringify(input.payload)],
    );
    if (rows.rows[0].state === "queued") {
      await client.query("UPDATE projects SET status='generating',last_error=NULL,updated_at=now() WHERE id=$1 AND status NOT IN ('cancelled')", [input.projectId]);
    }
    return rows.rows[0];
  });
  const queued = row.state === "queued";
  if (queued) {
    await movieQueue().add("dialogue-patch", { databaseJobId: row.id }, {
      jobId: createHash("sha256").update(`${input.idempotencyKey}:envelope:${randomUUID()}`).digest("hex"),
    });
  }
  return { jobId: row.id, queued, state: row.state };
}

export async function enqueueAssembly(input: {
  projectId: string;
  format: "mp4" | "mov";
  resolution: "720p" | "1080p" | "4k";
  sceneId?: string;
}): Promise<{ exportId: string; jobId: string; state: string; queued: boolean }> {
  const result = await transaction(async (client) => {
    const readiness = await client.query<{ total: number; completed: number; active_videos: number }>(
      `SELECT
         (SELECT count(*)::int FROM shots sh WHERE sh.project_id=p.id AND sh.state<>'cancelled' AND ($2::text IS NULL OR sh.scene_id=$2)) total,
         (SELECT count(*)::int FROM shots sh WHERE sh.project_id=p.id AND sh.state='completed' AND ($2::text IS NULL OR sh.scene_id=$2)) completed,
         (SELECT count(DISTINCT a.shot_id)::int FROM generation_assets a
            JOIN shot_versions sv ON sv.id=a.shot_version_id AND sv.active=true
            JOIN shots sh ON sh.id=a.shot_id
             WHERE a.project_id=p.id AND a.kind='video' AND sh.state<>'cancelled' AND ($2::text IS NULL OR sh.scene_id=$2)) active_videos
       FROM projects p WHERE p.id=$1`,
      [input.projectId, input.sceneId ?? null],
    );
    const state = readiness.rows[0];
    if (!state) throw Object.assign(new Error("Проект не найден."), { status: 404 });
    if (!state.total) {
      throw Object.assign(new Error(input.sceneId ? "Сцена не найдена или в ней нет кадров." : "В проекте нет кадров для экспорта."), { status: 409 });
    }
    if (state.completed !== state.total || state.active_videos !== state.total) {
      throw Object.assign(new Error(`Экспорт будет доступен после завершения всех кадров (${state.completed}/${state.total}).`), { status: 409 });
    }
    const versions = await client.query<{ versions: string }>(
      `SELECT string_agg(sv.id::text,',' ORDER BY sv.created_at) versions FROM shot_versions sv
       JOIN shots sh ON sh.id=sv.shot_id WHERE sv.active=true AND sh.project_id=$1 AND sh.state<>'cancelled' AND ($2::text IS NULL OR sh.scene_id=$2)`,
      [input.projectId, input.sceneId ?? null],
    );
    const key = `assemble:${input.projectId}:${input.sceneId ?? "all"}:${input.format}:${createHash("sha256").update(versions.rows[0]?.versions ?? "").digest("hex")}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
    const existing = await client.query<{ id: string; state: string; payload: { exportId?: string } }>("SELECT id,state,payload FROM jobs WHERE idempotency_key=$1 FOR UPDATE", [key]);
    if (existing.rows[0]?.payload.exportId) {
      const shouldEnqueue = ["failed", "paused", "cancelled"].includes(existing.rows[0].state);
      if (shouldEnqueue) {
        await client.query("UPDATE jobs SET state='queued',attempt=0,available_at=now(),last_error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1", [existing.rows[0].id]);
        await client.query("UPDATE exports SET state='queued',storage_key=NULL,completed_at=NULL,qc_report=NULL WHERE id=$1", [existing.rows[0].payload.exportId]);
      }
      return { exportId: existing.rows[0].payload.exportId, jobId: existing.rows[0].id, enqueue: shouldEnqueue, key, state: shouldEnqueue ? "queued" : existing.rows[0].state };
    }
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
    return { exportId: exportRow.rows[0].id, jobId: job.rows[0].id, enqueue: true, key, state: "queued" };
  });
  // Queue publication happens after the database commit. If Redis is briefly
  // unavailable, the durable queued row remains visible to reconciliation.
  if (result.enqueue) {
    await movieQueue().add("assemble-movie", { databaseJobId: result.jobId }, {
      jobId: createHash("sha256").update(`${result.key}:envelope:${randomUUID()}`).digest("hex"),
    });
  }
  return { exportId: result.exportId, jobId: result.jobId, state: result.state, queued: result.enqueue };
}

export async function enqueueAutomaticAssemblyIfReady(projectId: string): Promise<boolean> {
  const rows = await query<{ resolution: "preview" | "720p" | "1080p" | "4k"; completed: number; total: number; active_audio: number }>(
    `SELECT p.resolution,
       count(s.id) FILTER (WHERE s.state='completed')::int completed,
       count(s.id) FILTER (WHERE s.state<>'cancelled')::int total,
       (SELECT count(*)::int FROM jobs j WHERE j.project_id=p.id AND j.type='dialogue-patch'
          AND j.state IN ('planned','queued','retrying','generating','validating')) active_audio
     FROM projects p LEFT JOIN shots s ON s.project_id=p.id WHERE p.id=$1 GROUP BY p.id`,
    [projectId],
  );
  const state = rows[0];
  // Shot state and the active dialogue queue are authoritative. Historical
  // failed attempts must not block assembly after a later retry succeeded.
  if (!state || !state.total || state.completed !== state.total || state.active_audio) return false;
  const assembly = await enqueueAssembly({ projectId, format: "mp4", resolution: state.resolution === "preview" ? "720p" : state.resolution });
  if (assembly.state === "completed") {
    // A completed export is authoritative. This also repairs projects that a
    // later, non-essential job incorrectly left in `failed` or `generating`.
    await query("UPDATE projects SET status='completed',progress=100,last_error=NULL,updated_at=now() WHERE id=$1 AND status<>'cancelled'", [projectId]);
  } else {
    await query("UPDATE projects SET status='assembling' WHERE id=$1 AND status NOT IN ('completed','cancelled')", [projectId]);
  }
  return true;
}
