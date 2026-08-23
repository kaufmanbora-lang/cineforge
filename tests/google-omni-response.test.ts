import { describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { extractOmniVideo, extractVeoVideo, googleVeoConfig, normalizeGoogleProviderError, readVeoOperationResponse } from "@/server/providers/video/google";
import { durableProviderOperation, generationAccountingCost, moderationRetryPayload, omniFallbackPayload, providerDurationSeconds, resumableProviderOperation, veoNeutralRescuePayload } from "@/server/worker/process-shot";
import { normalizeMoviePlanRuntime } from "@/server/providers/video/prompt-adapters";
import type { MoviePlan } from "@/domain/movie";
import { character, location, scene, shot } from "./fixtures";

describe("Google Omni response parsing", () => {
  it("does not send the Enterprise-only seed parameter to Gemini Developer API", () => {
    const plannedShot = shot("shot-1");
    expect(googleVeoConfig({
      projectId: "project-1",
      sceneId: plannedShot.sceneId,
      shotId: plannedShot.id,
      modelId: "veo-3.1-fast-generate-preview",
      prompt: plannedShot.generationPrompt!.prompt,
      negativeDirectives: [],
      durationSeconds: 8,
      resolution: "720p",
      aspectRatio: "16:9",
      seed: 42,
      references: [],
      fastMode: true,
    })).not.toHaveProperty("seed");
  });

  it("omits an unsupported single Veo reference image", () => {
    const plannedShot = shot("shot-1");
    const request = {
      projectId: "project-1",
      sceneId: plannedShot.sceneId,
      shotId: plannedShot.id,
      modelId: "veo-3.1-fast-generate-preview",
      prompt: plannedShot.generationPrompt!.prompt,
      negativeDirectives: [],
      durationSeconds: 8,
      resolution: "720p" as const,
      aspectRatio: "16:9" as const,
      seed: null,
      references: [],
      fastMode: true,
    };
    const oneReference = [{ id: "portrait", data: "AAAA", mimeType: "image/png", role: "subject" as const }];
    expect(googleVeoConfig(request, undefined, oneReference).referenceImages).toBeUndefined();
    expect(googleVeoConfig(request, undefined, [...oneReference, { ...oneReference[0], id: "wardrobe" }]).referenceImages).toHaveLength(2);
  });

  it("maps screenplay timing to durations accepted by each video model", () => {
    expect(providerDurationSeconds("veo-3.1-fast-generate-preview", "720p", 5)).toBe(6);
    expect(providerDurationSeconds("veo-3.1-fast-generate-preview", "720p", 7)).toBe(8);
    expect(providerDurationSeconds("gemini-omni-flash-preview", "720p", 5)).toBe(5);
  });

  it("extracts the production Interactions API video content part", () => {
    expect(extractOmniVideo({
      steps: [
        { content: [{ type: "text", data: "not-video" }] },
        { content: [{ type: "video", data: "AAAA", mime_type: "video/mp4" }] },
      ],
    })).toEqual({ type: "video", data: "AAAA", mime_type: "video/mp4" });
  });

  it("extracts the raw Gemini Developer API long-running Veo response", () => {
    expect(extractVeoVideo({ response: { generateVideoResponse: { generatedSamples: [
      { video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/movie" } },
    ] } } })).toEqual({ uri: "https://generativelanguage.googleapis.com/v1beta/files/movie" });
  });

  it("normalizes raw MLDev inline video fields before persistence", () => {
    expect(extractVeoVideo({ response: { generateVideoResponse: { generatedSamples: [
      { video: { encodedVideo: "AAAA", encoding: "video/mp4" } },
    ] } } })).toMatchObject({ videoBytes: "AAAA", mimeType: "video/mp4" });
  });

  it("accepts a renamed base64 video field from a forward-compatible REST response", () => {
    const encoded = Buffer.alloc(256, 7).toString("base64");
    expect(extractVeoVideo({ response: { generateVideoResponse: { generatedSamples: [
      { video: { futureVideoPayload: encoded, encoding: "video/mp4" } as never },
    ] } } })?.videoBytes).toBe(encoded);
  });

  it("streams a large inline Veo response to a temporary video file", async () => {
    const expected = Buffer.from("test-video-payload");
    const payload = JSON.stringify({
      done: true,
      response: { generateVideoResponse: { generatedSamples: [{ video: { encoding: "video/mp4", encodedVideo: expected.toString("base64") } }] } },
    });
    const response = new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < payload.length; offset += 7) controller.enqueue(new TextEncoder().encode(payload.slice(offset, offset + 7)));
        controller.close();
      },
    }));
    const raw = await readVeoOperationResponse(response) as Parameters<typeof extractVeoVideo>[0];
    const video = extractVeoVideo(raw)!;
    expect(video.localFilePath).toBeTruthy();
    expect(Buffer.from(await readFile(video.localFilePath!))).toEqual(expected);
    expect(video.byteSize).toBe(expected.length);
    await rm(video.localFilePath!, { force: true });
  });

  it("streams URL-safe inline video wrapped in a data URL", async () => {
    const expected = Buffer.alloc(256, 251);
    const encoded = expected.toString("base64url");
    const payload = JSON.stringify({ done: true, response: { generatedVideos: [{ video: {
      futureVideoPayload: `data:video/mp4;base64,${encoded}`,
      mimeType: "video/mp4",
    } }] } });
    const response = new Response(payload, { headers: { "content-length": String(9 * 1024 * 1024) } });
    const parsed = await readVeoOperationResponse(response) as {
      response: { generateVideoResponse: { generatedSamples: Array<{ video: { localFilePath: string } }> } };
    };
    const filePath = parsed.response.generateVideoResponse.generatedSamples[0].video.localFilePath;
    expect(await readFile(filePath)).toEqual(expected);
    await rm(filePath, { force: true });
  });

  it("preserves a chunked Veo moderation response for automatic recovery", async () => {
    const payload = JSON.stringify({ done: true, response: { generateVideoResponse: {
      raiMediaFilteredCount: 1,
      raiMediaFilteredReasons: ["Output video was blocked by safety filters"],
    } } });
    const parsed = await readVeoOperationResponse(new Response(payload)) as {
      response: { generateVideoResponse: { raiMediaFilteredCount: number; raiMediaFilteredReasons: string[] } };
    };
    expect(parsed.response.generateVideoResponse).toMatchObject({
      raiMediaFilteredCount: 1,
      raiMediaFilteredReasons: ["Output video was blocked by safety filters"],
    });
  });

  it("rephrases a filtered shot once and changes its content hash", () => {
    const plannedShot = shot("shot-safety");
    const payload = { shot: { ...plannedShot, generationPrompt: plannedShot.generationPrompt! }, specHash: "original" };
    const retried = moderationRetryPayload(payload);
    expect(retried.specHash).not.toBe(payload.specHash);
    expect(retried.shot.generationPrompt?.prompt).toContain("CINEFORGE SAFETY RETRY");
    expect(moderationRetryPayload(retried)).toBe(retried);
  });

  it("switches only the repeatedly filtered shot to OmniFlash", () => {
    const plannedShot = shot("shot-omni-fallback");
    const safeRetry = moderationRetryPayload({ shot: { ...plannedShot, generationPrompt: plannedShot.generationPrompt! }, specHash: "original" });
    const fallback = omniFallbackPayload(safeRetry);
    expect(fallback.providerModelId).toBe("gemini-omni-flash-preview");
    expect(fallback.specHash).not.toBe(safeRetry.specHash);
    expect(fallback.shot.generationPrompt?.prompt).toContain("CINEFORGE OMNI FALLBACK");
    expect(omniFallbackPayload(fallback)).toBe(fallback);
  });

  it("returns an Omni billing failure to Veo with a neutral bounded prompt", () => {
    const plannedShot = shot("shot-veo-rescue");
    const omni = omniFallbackPayload({ shot: { ...plannedShot, generationPrompt: plannedShot.generationPrompt! }, specHash: "original" });
    const rescued = veoNeutralRescuePayload(omni);
    expect(rescued.providerModelId).toBe("veo-3.1-fast-generate-preview");
    expect(rescued.specHash).not.toBe(omni.specHash);
    expect(rescued.shot.generationPrompt?.prompt).toContain("CINEFORGE VEO NEUTRAL RESCUE");
    expect(veoNeutralRescuePayload(rescued)).toBe(rescued);
  });

  it("resumes a persisted SDK polling failure without starting a second paid generation", () => {
    const saved = {
      provider: "google" as const,
      modelId: "veo-3.1-fast-generate-preview",
      operationId: "models/veo-3.1-fast-generate-preview/operations/abc",
      state: "failed" as const,
      error: { code: "GOOGLE_REQUEST_FAILED", message: "operation._fromAPIResponse is not a function", retryable: false },
    };
    expect(resumableProviderOperation(saved, "same-shot-spec")).toMatchObject({ operationId: saved.operationId, state: "pending" });
    expect(resumableProviderOperation({ ...saved, operationId: "projects/p/locations/us/models/veo/operations/abc" }, "same-shot-spec"))
      .toMatchObject({ state: "pending" });
  });

  it("re-polls a completed Veo operation after a parser upgrade without paying twice", () => {
    const saved = {
      provider: "google" as const,
      modelId: "veo-3.1-fast-generate-preview",
      operationId: "models/veo-3.1-fast-generate-preview/operations/already-paid",
      state: "failed" as const,
      error: { code: "GOOGLE_REQUEST_FAILED", message: "Google completed the operation without downloadable video media.", retryable: false },
      specHash: "same-shot-spec",
    };
    expect(resumableProviderOperation(saved, "same-shot-spec")).toMatchObject({ state: "pending", operationId: saved.operationId });
  });

  it("resumes a completed URI result without making a second paid request", () => {
    const saved = {
      provider: "google" as const,
      modelId: "gemini-omni-flash-preview",
      operationId: "v1_interaction",
      state: "completed" as const,
      output: { mimeType: "video/mp4", providerUri: "https://generativelanguage.googleapis.com/v1beta/files/movie" },
      specHash: "same-shot-spec",
    };
    expect(resumableProviderOperation(saved, "same-shot-spec")).toEqual(saved);
  });

  it("never persists inline video bytes in the database checkpoint", () => {
    const persisted = durableProviderOperation({
      provider: "google",
      modelId: "veo-3.1-fast-generate-preview",
      operationId: "operations/123",
      state: "completed",
      output: { bytes: new Uint8Array([1, 2, 3]), mimeType: "video/mp4" },
    }, "hash", new Date(0).toISOString());
    expect(persisted.output?.bytes).toBeUndefined();
  });

  it("does not label every failed precondition as a billing failure", () => {
    expect(normalizeGoogleProviderError({ status: 400, message: "FAILED_PRECONDITION: another precondition" }).code)
      .toBe("GOOGLE_REQUEST_FAILED");
  });

  it("does not charge a recovered staged video twice", () => {
    expect(generationAccountingCost(1, 0, true)).toBe(0);
    expect(generationAccountingCost(1, 1, true)).toBe(1);
    expect(generationAccountingCost(1, 0, false)).toBe(1);
  });

  it("plans an exact ten-second Omni movie as linked five-second beats", () => {
    const longShot = { ...shot("shot-1"), durationSeconds: 10 };
    const sourceScene = scene([longShot]);
    const plan: MoviePlan = {
      id: "plan-1", projectId: "project-1", createdAt: new Date(0).toISOString(),
      summary: { title: "Test", genre: "Drama", style: "realistic", mood: "calm", durationSeconds: 10, logline: "Test", synopsis: "Test" },
      characters: [character()], locations: [location()], acts: [{ id: "act-1", number: 1, title: "Act", purpose: "Test", startSceneNumber: 1, endSceneNumber: 1 }], scenes: [sourceScene],
    };
    const normalized = normalizeMoviePlanRuntime(plan, "gemini-omni-flash-preview");
    const shots = normalized.scenes.flatMap((item) => item.shots);
    expect(shots.map((item) => item.durationSeconds)).toEqual([5, 5]);
    expect(shots.reduce((sum, item) => sum + item.durationSeconds, 0)).toBe(10);
    expect(shots[1].continuity.previousShotId).toBe(shots[0].id);
    expect(shots[1].dependencies).toContain(shots[0].id);
  });
});
