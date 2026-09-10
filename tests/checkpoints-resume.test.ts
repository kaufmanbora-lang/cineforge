import { describe, expect, it } from "vitest";
import { nextCheckpoint, resumeFromCheckpoint, type CheckpointSnapshot } from "@/server/movie/checkpoints";
import { preservePreviewUrls } from "@/domain/movie";
import { estimateRemainingGenerationSeconds, formatRemainingGenerationTime } from "@/domain/estimation";
import { assembleMovieFiles, canStreamCopyVideo } from "@/server/movie/ffmpeg";
import { createExpressDraftMoviePlan, moviePlanRequest } from "@/server/providers/openai";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

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

describe("dynamic generation ETA", () => {
  const completedJob = {
    type: "generate-shot",
    state: "completed",
    started_at: "2026-01-01T10:00:00.000Z",
    completed_at: "2026-01-01T10:01:00.000Z",
  };

  it("learns from completed shots and counts only unfinished work", () => {
    const seconds = estimateRemainingGenerationSeconds({
      jobs: [completedJob], completedShots: 1, totalShots: 3,
      status: "generating", modelId: "gemini-omni-flash-preview",
      nowMs: Date.parse("2026-01-01T10:02:00.000Z"),
    });
    expect(seconds).toBe(140);
    expect(formatRemainingGenerationTime(seconds!)).toBe("около 3 мин");
  });

  it("extends the estimate when an active provider call takes longer than usual", () => {
    const seconds = estimateRemainingGenerationSeconds({
      jobs: [{ ...completedJob, state: "generating", completed_at: null, started_at: "2026-01-01T10:00:00.000Z" }],
      completedShots: 0, totalShots: 1, status: "generating", modelId: "gemini-omni-flash-preview",
      nowMs: Date.parse("2026-01-01T10:05:00.000Z"),
    });
    expect(seconds).toBe(80);
  });

  it("pauses the countdown when production is stopped", () => {
    expect(estimateRemainingGenerationSeconds({ jobs: [], completedShots: 1, totalShots: 3, status: "failed", modelId: "gemini-omni-flash-preview" })).toBeNull();
  });

  it("uses only a short planning allowance for a one-shot express render", () => {
    expect(estimateRemainingGenerationSeconds({ jobs: [], completedShots: 0, totalShots: 1, status: "planning", modelId: "gemini-omni-flash-preview" })).toBe(100);
  });
});

describe("ten-second express planning", () => {
  it("requests three full ten-second beats for a thirty-second Omni draft", () => {
    expect(moviePlanRequest({ projectId: "p", idea: "A continuous journey", durationSeconds: 30, videoModelId: "gemini-omni-flash-preview", fastDraft: true })).toContain("exactly 3 shots with durations [10, 10, 10]");
    expect(moviePlanRequest({ projectId: "p", idea: "A continuous journey", durationSeconds: 30, videoModelId: "veo-3.1-fast-generate-preview", fastDraft: true })).toContain("exactly 4 shots with durations [8, 8, 8, 6]");
  });
  it("creates one exact-duration production shot without waiting for an LLM", () => {
    const plan = createExpressDraftMoviePlan({
      projectId: "project-express",
      idea: "Мужчина идёт по зимнему Нью-Йорку и говорит: «Привет, как дела?»",
      durationSeconds: 10,
    });
    expect(plan.summary.durationSeconds).toBe(10);
    expect(plan.scenes).toHaveLength(1);
    expect(plan.scenes[0].shots).toHaveLength(1);
    expect(plan.scenes[0].shots[0].durationSeconds).toBe(10);
    expect(plan.scenes[0].shots[0].audioContext.dialogue[0].text).toBe("Привет, как дела?");
    expect(plan.scenes[0].shots[0].action).toContain("зимнему Нью-Йорку");
  });
});

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
const hasMediaTools = [ffmpeg, ffprobe].every((bin) => spawnSync(bin, ["-version"], { windowsHide: true, timeout: 10_000 }).status === 0);
describe.skipIf(!hasMediaTools)("real FFmpeg end-to-end assembly (no video API calls)", () => {
  const run = promisify(execFile);
  it.each([{ clips: 3, seconds: 10, resolution: "720p" as const }, { clips: 6, seconds: 5, resolution: "1080p" as const }])(
    "assembles $clips × $seconds seconds into exactly 30s at $resolution without AAC timestamp drift", async ({ clips, seconds, resolution }) => {
      const root = await mkdtemp(join(tmpdir(), "cineforge-media-regression-"));
      try {
        const paths: string[] = [];
        for (const [n, color] of ["red", "green", "blue"].entries()) {
          const file = join(root, `source-${n}.mp4`);
          await run(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", `color=c=${color}:s=1280x720:r=24`, "-f", "lavfi", "-i", `sine=frequency=${440 + n * 220}:sample_rate=44100`, "-t", String(seconds + (clips === 6 ? 0.25 : 0)), "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-c:a", "aac", file], { windowsHide: true, timeout: 30_000 });
          paths.push(file);
        }
        const output = join(root, "movie.mp4");
        const stages: string[] = [];
        const qc = await assembleMovieFiles({
          clips: Array.from({ length: clips }, (_, n) => ({ filePath: paths[n % 3], durationSeconds: seconds })), resolution, outputPath: output,
          onProgress: async (stage) => { stages.push(stage); },
        });
        expect(qc.issues).toEqual([]);
        expect(qc.passed).toBe(true);
        expect(Math.abs(qc.probe.duration - 30)).toBeLessThanOrEqual(1 / 24);
        expect(stages.at(-1)).toBe("quality-check");
        for (let n = 0; n < clips; n++) {
          const { stdout } = await run(ffmpeg, ["-v", "error", "-ss", String(n * seconds + 0.5), "-i", output, "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", windowsHide: true });
          const channels = [...stdout];
          expect(channels.indexOf(Math.max(...channels))).toBe(n % 3);
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    }, 120_000,
  );
});

describe("fast assembly path", () => {
  it("preserves compatible provider frames without an unnecessary H.264 re-encode", () => {
    expect(canStreamCopyVideo({ width: 1280, height: 720, frameRate: 24 }, "720p")).toBe(true);
    expect(canStreamCopyVideo({ width: 1280, height: 720, frameRate: 23.976 }, "720p")).toBe(false);
    expect(canStreamCopyVideo({ width: 1280, height: 720, frameRate: 24 }, "1080p")).toBe(false);
  });
});
