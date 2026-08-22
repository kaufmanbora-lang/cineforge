import { describe, expect, it } from "vitest";
import { extractOmniVideo, extractVeoVideo, googleVeoConfig, normalizeGoogleProviderError } from "@/server/providers/video/google";
import { generationAccountingCost, providerDurationSeconds, resumableProviderOperation } from "@/server/worker/process-shot";
import { shot } from "./fixtures";

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

  it("resumes a persisted SDK polling failure without starting a second paid generation", () => {
    const saved = {
      provider: "google" as const,
      modelId: "veo-3.1-fast-generate-preview",
      operationId: "models/veo-3.1-fast-generate-preview/operations/abc",
      state: "failed" as const,
      error: { code: "GOOGLE_REQUEST_FAILED", message: "operation._fromAPIResponse is not a function", retryable: false },
    };
    expect(resumableProviderOperation(saved, "same-shot-spec")).toMatchObject({ operationId: saved.operationId, state: "pending" });
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
});
