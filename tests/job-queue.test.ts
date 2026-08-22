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
});
