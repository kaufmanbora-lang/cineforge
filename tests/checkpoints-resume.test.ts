import { describe, expect, it } from "vitest";
import { nextCheckpoint, resumeFromCheckpoint, type CheckpointSnapshot } from "@/server/movie/checkpoints";
import { preservePreviewUrls } from "@/domain/movie";

const initial: CheckpointSnapshot = { projectId: "p", planVersion: 1, completedShotIds: ["s1"], failedShotIds: [], pendingShotIds: ["s2","s3"], currentJobId: "j2", spentUsd: 1, projectMemoryHash: "memory", createdAt: "2026-01-01" };

describe("durable checkpoints and resume", () => {
  it("persists a completed shot and resumes from the next unfinished shot", () => {
    const checkpoint = nextCheckpoint(initial, { type: "shot-completed", shotId: "s2", spentDeltaUsd: 0.8, currentJobId: null });
    expect(checkpoint.completedShotIds).toEqual(["s1","s2"]);
    expect(checkpoint.pendingShotIds).toEqual(["s3"]);
    expect(checkpoint.spentUsd).toBe(1.8);
    expect(resumeFromCheckpoint(checkpoint, ["s1","s2","s3"])).toEqual({ completedShotIds: ["s1","s2"], resumeShotIds: ["s3"] });
  });
  it("never schedules a completed shot again even if pending data is stale", () => {
    expect(resumeFromCheckpoint({ ...initial, pendingShotIds: ["s1","s2","s3"] }, ["s1","s2","s3"]).resumeShotIds).toEqual(["s2","s3"]);
  });
  it("does not restart a playing immutable preview when a signed URL is renewed", () => {
    const current = [{ shot_id: "s1", scene_id: "scene-1", version: 1, url: "signed-old", score: 80 }];
    const incoming = [
      { shot_id: "s1", scene_id: "scene-1", version: 1, url: "signed-renewed", score: 80 },
      { shot_id: "s2", scene_id: "scene-1", version: 1, url: "signed-new", score: 90 },
    ];
    expect(preservePreviewUrls(current, incoming).map((clip) => clip.url)).toEqual(["signed-old", "signed-new"]);
    expect(preservePreviewUrls(current, [{ ...current[0], version: 2, url: "edited-version" }])[0].url).toBe("edited-version");
  });
});
