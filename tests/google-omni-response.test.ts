import { describe, expect, it } from "vitest";
import { extractOmniVideo, googleVeoConfig, normalizeGoogleProviderError } from "@/server/providers/video/google";
import { generationAccountingCost } from "@/server/worker/process-shot";
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

  it("extracts the production Interactions API video content part", () => {
    expect(extractOmniVideo({
      steps: [
        { content: [{ type: "text", data: "not-video" }] },
        { content: [{ type: "video", data: "AAAA", mime_type: "video/mp4" }] },
      ],
    })).toEqual({ type: "video", data: "AAAA", mime_type: "video/mp4" });
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
