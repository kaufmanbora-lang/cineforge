import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { persistMoviePlan, latestMoviePlan } from "@/server/movie/repository";
import { createExpressDraftMoviePlan } from "@/server/providers/openai";
import { enqueueJobs, reconcileQueuedJobs, recoverStaleJobs } from "@/server/movie/queue";
import { planGenerationJobs, readyJobs } from "@/server/movie/job-planner";
import { isLegacyAutomaticDialogueJob, retryEnvelopeJobId } from "@/server/movie/queue";
import { scene, shot } from "./fixtures";

const harness = vi.hoisted(() => ({ db: null as PGlite | null, add: vi.fn().mockResolvedValue({}) }));
vi.mock("@/server/db", () => ({
  query: async (sql: string, values: unknown[] = []) => (await harness.db!.query(sql, values)).rows,
  transaction: async (fn: (client: PoolClient) => Promise<unknown>) => harness.db!.transaction((tx) => fn(tx as unknown as PoolClient)),
}));
vi.mock("bullmq", () => ({ Queue: class { add = harness.add; } }));

beforeAll(async () => {
  harness.db = new PGlite();
  const schema = await readFile(new URL("../db/migrations/001_init.sql", import.meta.url), "utf8");
  await harness.db.exec(schema.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
  // Tests explicitly move heartbeat timestamps into the past without waiting.
  await harness.db.exec("ALTER TABLE jobs DISABLE TRIGGER touch_jobs");
}, 30_000);
afterAll(async () => { await harness.db?.close(); });
beforeEach(async () => { harness.add.mockClear(); await harness.db!.exec("TRUNCATE projects CASCADE"); });

describe("real PostgreSQL queue recovery regressions", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  async function prepare() {
    await harness.db!.query(`INSERT INTO projects(id,workspace_id,title,prompt,duration_seconds,model_id,resolution,aspect_ratio,status)
      VALUES ($1,'00000000-0000-4000-8000-000000000001','Queue test','Three continuous shots',30,'gemini-omni-flash-preview','720p','16:9','queued')`, [projectId]);
    const plan = createExpressDraftMoviePlan({ projectId, idea: "A red ball rolls along a wooden track", durationSeconds: 10 });
    plan.summary.durationSeconds = 30;
    const base = plan.scenes[0].shots[0];
    plan.scenes[0].durationSeconds = 30;
    plan.scenes[0].shots = [1, 2, 3].map((n) => ({ ...base, id: `shot-${n}`, sequence: n, dependencies: n > 1 ? [`shot-${n - 1}`] : [] }));
    await persistMoviePlan(plan);
    await harness.db!.query("UPDATE projects SET status='queued' WHERE id=$1", [projectId]);
    const stored = await latestMoviePlan(projectId);
    const jobs = planGenerationJobs(projectId, stored!.scenes, { fastDraft: true });
    await enqueueJobs(jobs);
    return jobs;
  }
  it("schedules 1 → 2 → 3 even when the worker crashes after each checkpoint but before queue publication", async () => {
    const jobs = await prepare();
    // Simulate a plan persisted by an older build with a 2 ↔ 3 dependency cycle.
    await harness.db!.query("UPDATE jobs SET payload=jsonb_set(payload,'{shot,dependencies}',$2::jsonb) WHERE shot_id=$1", [jobs[1].shotId, JSON.stringify([jobs[0].shotId, jobs[2].shotId])]);
    for (let n = 0; n < 2; n++) {
      await harness.db!.query("UPDATE shots SET state='completed' WHERE id=$1", [jobs[n].shotId]);
      await harness.db!.query("UPDATE jobs SET state='completed' WHERE shot_id=$1", [jobs[n].shotId]);
      harness.add.mockClear();
      await reconcileQueuedJobs();
      const rows = (await harness.db!.query<{ shot_id: string; state: string }>("SELECT shot_id,state FROM jobs ORDER BY shot_id")).rows;
      expect(rows[n + 1].state).toBe("queued");
      expect(rows.slice(0, n + 1).every((row) => row.state === "completed")).toBe(true);
      expect(harness.add).toHaveBeenCalled();
    }
  });
  it("keeps corrected payload, attempts and future cooldown unchanged across repeated enqueue/deployment", async () => {
    const jobs = await prepare();
    await harness.db!.exec(`UPDATE jobs SET attempt=2,payload=payload || '{"repair":"keep me"}'::jsonb,available_at=now()+interval '10 minutes' WHERE state='queued'`);
    const before = (await harness.db!.query("SELECT payload,attempt,available_at FROM jobs WHERE state='queued'")).rows;
    await enqueueJobs(jobs);
    expect((await harness.db!.query("SELECT payload,attempt,available_at FROM jobs WHERE state='queued'")).rows).toEqual(before);
    harness.add.mockClear();
    await reconcileQueuedJobs();
    expect(harness.add).not.toHaveBeenCalled();
  });
  it("bounds crash recovery, preserves completed shots, and never revives a fresh heartbeat", async () => {
    const jobs = await prepare();
    await harness.db!.query("UPDATE shots SET state='completed' WHERE id=$1", [jobs[0].shotId]);
    await harness.db!.query("UPDATE jobs SET state='completed' WHERE shot_id=$1", [jobs[0].shotId]);
    await harness.db!.query("UPDATE jobs SET state='generating',attempt=2,updated_at=now()-interval '3 minutes' WHERE shot_id=$1", [jobs[1].shotId]);
    expect(await recoverStaleJobs()).toBe(1);
    await harness.db!.query("UPDATE jobs SET state='generating',attempt=3,updated_at=now() WHERE shot_id=$1", [jobs[1].shotId]);
    expect(await recoverStaleJobs()).toBe(0);
    await harness.db!.query("UPDATE jobs SET updated_at=now()-interval '3 minutes' WHERE shot_id=$1", [jobs[1].shotId]);
    expect(await recoverStaleJobs()).toBe(1);
    expect(await recoverStaleJobs()).toBe(0);
    expect((await harness.db!.query<{ status: string }>("SELECT status FROM projects")).rows[0].status).toBe("paused");
    expect((await harness.db!.query<{ state: string }>("SELECT state FROM shots WHERE id=$1", [jobs[0].shotId])).rows[0].state).toBe("completed");
  });
  it("recovers an interrupted assembly promptly but leaves a live FFmpeg heartbeat alone", async () => {
    await prepare();
    await harness.db!.query("UPDATE projects SET status='assembling' WHERE id=$1", [projectId]);
    await harness.db!.query(`INSERT INTO jobs(project_id,type,state,idempotency_key,payload,attempt,updated_at)
      VALUES ($1,'assemble-movie','generating','assembly-heartbeat','{}',1,now())`, [projectId]);
    expect(await recoverStaleJobs()).toBe(0);
    await harness.db!.exec("UPDATE jobs SET updated_at=now()-interval '3 minutes' WHERE type='assemble-movie'");
    expect(await recoverStaleJobs()).toBe(1);
    expect((await harness.db!.query<{ state: string; attempt: number }>("SELECT state,attempt FROM jobs WHERE type='assemble-movie'")).rows[0]).toEqual({ state: "queued", attempt: 1 });
    expect(await recoverStaleJobs()).toBe(0);
  });
});

describe("idempotent dependency-aware job queue", () => {
  it("generates stable idempotency keys", () => {
    const scenes = [scene([shot("shot-1"), shot("shot-2", ["shot-1"])])];
    expect(planGenerationJobs("project", scenes).map((job) => job.idempotencyKey)).toEqual(planGenerationJobs("project", scenes).map((job) => job.idempotencyKey));
  });
  it("runs independent work in parallel but waits for dependencies", () => {
    const shots = [shot("shot-1"), shot("shot-2", ["shot-1"]), shot("shot-3")];
    const jobs = planGenerationJobs("project", [scene(shots)]);
    expect(readyJobs(jobs, new Set(), new Set(), 4).map((job) => job.shotId)).toEqual(["shot-1","shot-3"]);
    expect(readyJobs(jobs, new Set(["shot-1"]), new Set(), 4).map((job) => job.shotId)).toEqual(["shot-2","shot-3"]);
  });
  it("does not deadlock after shot one when screenplay dependencies mistakenly point to a future shot", () => {
    const jobs = planGenerationJobs("project", [scene([shot("s1"), shot("s2", ["s1", "s3"]), shot("s3", ["s2"])])]);
    expect(jobs[1].dependencies).toEqual(["s1"]);
    expect(readyJobs(jobs, new Set(["s1"]), new Set(), 1)[0].shotId).toBe("s2");
    expect(readyJobs(jobs, new Set(["s1", "s2"]), new Set(), 1)[0].shotId).toBe("s3");
  });
  it("ignores non-shot graph IDs that would otherwise deadlock the queue", () => {
    const jobs = planGenerationJobs("project", [scene([shot("shot-1", ["character-1", "location-1"])])]);
    expect(jobs[0].dependencies).toEqual([]);
    expect(readyJobs(jobs, new Set(), new Set(), 1).map((job) => job.shotId)).toEqual(["shot-1"]);
  });
  it("preserves cross-scene continuity dependencies in fast draft mode", () => {
    const first = scene([shot("shot-1")]);
    const linked = { ...shot("shot-2", ["shot-1"]), sceneId: "scene-2", continuity: { ...shot("shot-2").continuity, previousShotId: "shot-1" } };
    const second = { ...scene([linked]), id: "scene-2", number: 2, shots: [linked] };
    const normal = planGenerationJobs("project", [first, second]);
    const draft = planGenerationJobs("project", [first, second], { fastDraft: true });
    expect(readyJobs(normal, new Set(), new Set(), 4).map((job) => job.shotId)).toEqual(["shot-1"]);
    expect(readyJobs(draft, new Set(), new Set(), 4).map((job) => job.shotId)).toEqual(["shot-1"]);
    expect(draft[1].dependencies).toEqual(["shot-1"]);
  });
  it("keeps chronological memory without serializing a hard cut", () => {
    const first = scene([shot("shot-1")]);
    const cut = { ...shot("shot-2"), sceneId: "scene-2", continuity: { ...shot("shot-2").continuity, previousShotId: "shot-1" } };
    const second = { ...scene([cut]), id: "scene-2", number: 2, locationId: "different-location", shots: [cut] };
    const jobs = planGenerationJobs("project", [first, second], { fastDraft: true });
    expect(jobs[1].dependencies).toEqual([]);
    expect(readyJobs(jobs, new Set(), new Set(), 4).map((job) => job.shotId)).toEqual(["shot-1", "shot-2"]);
  });
  it("creates a fresh retry envelope when a manual resume reuses an attempt number", () => {
    const first = retryEnvelopeJobId("database-job", 1, "run-a");
    const resumed = retryEnvelopeJobId("database-job", 1, "run-b");
    expect(first).not.toBe(resumed);
    expect(retryEnvelopeJobId("database-job", 1, "run-a")).toBe(first);
  });
  it("restores only legacy automatic voiceovers, never an explicit user edit", () => {
    expect(isLegacyAutomaticDialogueJob("dialogue-master:shot-1:hash")).toBe(true);
    expect(isLegacyAutomaticDialogueJob("dialogue-patch:shot-1:hash")).toBe(false);
  });
});
