import { describe, expect, it } from "vitest";
import { planGenerationJobs, readyJobs } from "@/server/movie/job-planner";
import { scene, shot } from "./fixtures";

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
  it("ignores non-shot graph IDs that would otherwise deadlock the queue", () => {
    const jobs = planGenerationJobs("project", [scene([shot("shot-1", ["character-1", "location-1"])])]);
    expect(jobs[0].dependencies).toEqual([]);
    expect(readyJobs(jobs, new Set(), new Set(), 1).map((job) => job.shotId)).toEqual(["shot-1"]);
  });
  it("parallelizes independent scenes in fast draft mode", () => {
    const first = scene([shot("shot-1")]);
    const second = { ...scene([shot("shot-2", ["shot-1"])]), id: "scene-2", number: 2, shots: [{ ...shot("shot-2", ["shot-1"]), sceneId: "scene-2" }] };
    const normal = planGenerationJobs("project", [first, second]);
    const draft = planGenerationJobs("project", [first, second], { fastDraft: true });
    expect(readyJobs(normal, new Set(), new Set(), 4).map((job) => job.shotId)).toEqual(["shot-1"]);
    expect(readyJobs(draft, new Set(), new Set(), 4).map((job) => job.shotId)).toEqual(["shot-1", "shot-2"]);
  });
});
