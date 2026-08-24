import { describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { createGoogleOmniInteraction, extractOmniVideo, extractVeoVideo, googleFileDownloadUrl, googleOmniInteractionRequest, googleOmniShouldStore, googleOmniVideoTask, googleVeoConfig, normalizeGoogleProviderError, readVeoOperationResponse } from "@/server/providers/video/google";
import { buildContinuityChainPrompt, durableProviderOperation, generationAccountingCost, moderationRetryPayload, neutralRescueAudioContext, neutralRescueContinuity, omniFallbackPayload, omniNeutralRescuePayload, providerAudioContext, providerDurationSeconds, providerSafetyFraming, restoreOmniAfterLegacyBillingFallbackPayload, resumableProviderOperation, shouldRestoreLegacyBillingFallback, veoNeutralRescuePayload, veoSafeBridgePayload } from "@/server/worker/process-shot";
import { carryPhysicalWorldForward, normalizeMoviePlanRuntime, physicalTransitionContract, realismProductionProfile } from "@/server/providers/video/prompt-adapters";
import { effectiveVideoModelId } from "@/domain/video-models";
import type { MoviePlan } from "@/domain/movie";
import { character, location, scene, shot } from "./fixtures";

describe("Google Omni response parsing", () => {
  it("never combines previous_interaction_id with a video task", () => {
    expect(googleOmniVideoTask({ previousInteractionId: "v1_previous", editInstruction: "Make the coat grey", references: [] })).toBeUndefined();
    expect(googleOmniVideoTask({ previousInteractionId: undefined, editInstruction: undefined, references: [{ id: "previous-frame", data: "AAAA", mimeType: "image/jpeg", role: "first-frame" }] })).toBe("image_to_video");
    expect(googleOmniVideoTask({ previousInteractionId: undefined, editInstruction: "Make the coat grey", references: [] })).toBe("text_to_video");
  });
  it("always stores URI-delivered Omni video, including fast drafts", () => {
    expect(googleOmniShouldStore({ fastMode: true })).toBe(true);
    expect(googleOmniShouldStore({ fastMode: false })).toBe(true);
    expect(googleOmniShouldStore({ fastMode: true, previousInteractionId: "v1", editInstruction: "Change the coat" })).toBe(true);
  });
  it("uses inline delivery for short fast drafts and keeps URI delivery for final renders", () => {
    const plannedShot = shot("shot-omni-request");
    const base = {
      projectId: "project-1",
      sceneId: plannedShot.sceneId,
      shotId: plannedShot.id,
      modelId: "gemini-omni-flash-preview",
      prompt: plannedShot.generationPrompt!.prompt,
      negativeDirectives: [],
      durationSeconds: 5,
      resolution: "1080p" as const,
      aspectRatio: "16:9" as const,
      seed: null,
      references: [],
      fastMode: true,
    };
    const textRequest = googleOmniInteractionRequest(base);
    expect(textRequest.store).toBe(true);
    expect(textRequest.response_format).toMatchObject({ type: "video" });
    expect((textRequest.response_format as Record<string, unknown>).delivery).toBeUndefined();

    const finalRequest = googleOmniInteractionRequest({ ...base, fastMode: false });
    expect(finalRequest.response_format).toMatchObject({ type: "video", delivery: "uri" });

    const referenceRequest = googleOmniInteractionRequest({
      ...base,
      references: [{ id: "first", role: "first-frame", data: "AAAA", mimeType: "image/jpeg" }],
    });
    expect(referenceRequest.store).toBe(true);
    expect(referenceRequest.generation_config).toEqual({ video_config: { task: "image_to_video" } });

    const editRequest = googleOmniInteractionRequest({
      ...base,
      previousInteractionId: "interaction-1",
      editInstruction: "Change only the coat colour",
    });
    expect(editRequest.store).toBe(true);
    expect(editRequest.previous_interaction_id).toBe("interaction-1");
    expect(editRequest.generation_config).toBeUndefined();
    expect(editRequest.response_format).toBeUndefined();
  });
  it("falls back from URI delivery to the documented inline video response for the specific store compatibility 400", async () => {
    const plannedShot = shot("shot-omni-inline-fallback");
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { code: 400, message: "store=true is required when response format has video delivery set to URI" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ id: "v1_ok", steps: [{ type: "model_output", content: [{ type: "video", data: "AAAA", mime_type: "video/mp4" }] }] }), { status: 200 });
    });
    const result = await createGoogleOmniInteraction({
      projectId: "project-1", sceneId: plannedShot.sceneId, shotId: plannedShot.id,
      modelId: "gemini-omni-flash-preview", prompt: plannedShot.generationPrompt!.prompt,
      negativeDirectives: [], durationSeconds: 5, resolution: "720p", aspectRatio: "16:9",
      seed: null, references: [], fastMode: false,
    }, "server-only-test-key", fetchMock);
    expect(result.id).toBe("v1_ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ store: true, response_format: { type: "video", delivery: "uri" } });
    expect(bodies[1]).toMatchObject({ store: true, response_format: { type: "video" } });
    expect((bodies[1].response_format as Record<string, unknown>).delivery).toBeUndefined();
  });
  it("does not retry an unrelated Omni HTTP 400", async () => {
    const plannedShot = shot("shot-omni-fatal-400");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 400, message: "Invalid prompt field" } }), { status: 400 }));
    await expect(createGoogleOmniInteraction({
      projectId: "project-1", sceneId: plannedShot.sceneId, shotId: plannedShot.id,
      modelId: "gemini-omni-flash-preview", prompt: plannedShot.generationPrompt!.prompt,
      negativeDirectives: [], durationSeconds: 5, resolution: "720p", aspectRatio: "16:9",
      seed: null, references: [], fastMode: true,
    }, "server-only-test-key", fetchMock)).rejects.toThrow("Invalid prompt field");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("turns an Omni Files API resource URI into the official media download endpoint", () => {
    expect(googleFileDownloadUrl("files/omni-output_123")).toBe("https://generativelanguage.googleapis.com/v1beta/files/omni-output_123:download?alt=media");
    expect(googleFileDownloadUrl("https://generativelanguage.googleapis.com/v1beta/files/omni-output_123"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/files/omni-output_123:download?alt=media");
  });
  it("uses a numeric fallback when the SDK status is a symbolic Google status", () => {
    expect(normalizeGoogleProviderError({ status: "RESOURCE_EXHAUSTED", code: 429, message: "Please retry later" }))
      .toMatchObject({ code: "GOOGLE_RATE_LIMIT", status: 429, retryable: true });
  });
  it("classifies a policy rejection before a generic 403 permission error", () => {
    expect(normalizeGoogleProviderError({ status: 403, message: "Blocked by safety policy" }).code).toBe("GOOGLE_MODERATION");
  });
  it("omits the Enterprise-only Veo seed from Gemini Developer API requests", () => {
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

  it("keeps one or more officially supported Veo reference images", () => {
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
    expect(googleVeoConfig(request, undefined, oneReference).referenceImages).toHaveLength(1);
    expect(googleVeoConfig(request, undefined, [...oneReference, { ...oneReference[0], id: "wardrobe" }]).referenceImages).toHaveLength(2);
    expect(googleVeoConfig({ ...request, aspectRatio: "9:16" }, undefined, oneReference).referenceImages).toBeUndefined();
    expect(googleVeoConfig(request, undefined, oneReference, { id: "first", data: "AAAA", mimeType: "image/jpeg", role: "first-frame" }).referenceImages).toBeUndefined();
  });

  it("maps screenplay timing to durations accepted by each video model", () => {
    expect(providerDurationSeconds("veo-3.1-fast-generate-preview", "720p", 5)).toBe(6);
    expect(providerDurationSeconds("veo-3.1-fast-generate-preview", "720p", 7)).toBe(8);
    expect(providerDurationSeconds("veo-3.1-fast-generate-preview", "720p", 4, true)).toBe(8);
    expect(providerDurationSeconds("gemini-omni-flash-preview", "720p", 5)).toBe(5);
    expect(providerDurationSeconds("gemini-omni-flash-preview", "1080p", 5)).toBe(5);
    expect(providerDurationSeconds("gemini-omni-flash-preview", "720p", 10)).toBe(10);
  });

  it("routes a Veo 3.1 draft to the official Fast model without changing final renders", () => {
    expect(effectiveVideoModelId("veo-3.1-generate-preview", "draft")).toBe("veo-3.1-fast-generate-preview");
    expect(effectiveVideoModelId("veo-3.1-generate-preview", "final")).toBe("veo-3.1-generate-preview");
    expect(effectiveVideoModelId("gemini-omni-flash-preview", "draft")).toBe("gemini-omni-flash-preview");
  });

  it("defaults ordinary film prompts to photorealistic live action", () => {
    expect(realismProductionProfile("grounded winter detective drama")).toContain("PHOTOREALISTIC LIVE-ACTION DEFAULT");
    expect(realismProductionProfile("не мультяшное реалистичное кино")).toContain("PHOTOREALISTIC LIVE-ACTION DEFAULT");
    expect(realismProductionProfile("hand-drawn animation")).toContain("explicitly requested animated");
  });

  it("binds persistent objects, vehicle motion, door topology and camera axis across shots", () => {
    const plannedShot = shot("shot-world-state");
    const prompt = buildContinuityChainPrompt("A car stops beside the curb", plannedShot.continuity, plannedShot.audioContext, true);
    expect(prompt).toContain("PERSISTENT OBJECT AND VEHICLE CONTRACT");
    expect(prompt).toContain("TOPOLOGY AND DOOR CONTRACT");
    expect(prompt).toContain("180-degree action axis");
    expect(prompt).toContain("exact final frame");
    expect(prompt).toContain("<FIRST_FRAME>");
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
    expect(retried.shot.generationPrompt?.prompt).toContain("SAFE FICTIONAL PRODUCTION FRAME");
    expect(retried.shot.generationPrompt?.prompt).not.toMatch(/weapon|violence|injury|pursuit|government/i);
    expect(moderationRetryPayload(retried)).toBe(retried);
  });

  it("pre-frames a fictional arrest without removing the requested story action", () => {
    const framed = providerSafetyFraming("Кортеж ФБР приезжает, спецназ спокойно задерживает взрослого человека.");
    expect(framed).toContain("вымышленная федеральная следственная группа");
    expect(framed).toContain("вымышленная тактическая группа");
    expect(framed).toContain("controlled lawful detention");
    expect(framed).not.toMatch(/\bФБР\b/i);
  });
  it("keeps sensitive dialogue for post-production instead of the video safety request", () => {
    const plannedShot = shot("shot-dialogue");
    const audio = { ...plannedShot.audioContext, speakers: ["character-elias"], dialogue: [{ id: "d1", characterId: "character-elias", characterName: "Elias", text: "ФБР! Руки вверх!", delivery: "firm", startSeconds: 0, durationSeconds: 2 }] };
    const safe = providerAudioContext(providerSafetyFraming("ФБР задерживает человека"), audio)!;
    expect(safe.dialogue).toEqual([]);
    expect(safe.speakers).toEqual([]);
    expect(audio.dialogue[0].text).toBe("ФБР! Руки вверх!");
  });

  it("uses one bounded neutral Omni rescue while preserving canonical post-production audio", () => {
    const plannedShot = shot("shot-omni-neutral");
    const audio = { ...plannedShot.audioContext, speakers: ["character-elias"], dialogue: [{ id: "d1", characterId: "character-elias", characterName: "Elias", text: "ФБР! Руки вверх!", delivery: "firm", startSeconds: 0, durationSeconds: 2 }] };
    const rescued = omniNeutralRescuePayload({ shot: { ...plannedShot, audioContext: audio, generationPrompt: plannedShot.generationPrompt! }, specHash: "original" });
    expect(rescued.providerModelId).toBe("gemini-omni-flash-preview");
    expect(rescued.shot.generationPrompt?.prompt).toContain("CINEFORGE OMNI NEUTRAL RESCUE");
    expect(rescued.shot.generationPrompt?.prompt).not.toMatch(/ФБР|наручник|задерж|оруж|weapon|restraint|threat|agency/i);
    expect(rescued.omitProviderReferences).toBe(false);
    expect(rescued.omitSubjectReferences).toBe(true);
    expect(providerAudioContext(rescued.shot.generationPrompt!.prompt, audio)?.dialogue).toEqual([]);
    expect(audio.dialogue[0].text).toBe("ФБР! Руки вверх!");
    expect(omniNeutralRescuePayload(rescued)).toEqual(rescued);
    const legacy = { ...rescued, shot: { ...rescued.shot, generationPrompt: { ...rescued.shot.generationPrompt!, prompt: `${rescued.shot.generationPrompt!.prompt} no visible weapon` } } };
    const refreshed = omniNeutralRescuePayload(legacy);
    expect(refreshed.shot.generationPrompt?.prompt).not.toContain("weapon");
    expect(refreshed).not.toBe(legacy);
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
    expect(rescued.omitProviderReferences).toBe(false);
    expect(rescued.omitSubjectReferences).toBe(true);
    expect(veoNeutralRescuePayload(rescued)).toEqual(rescued);
  });

  it("keeps the previous boundary frame while omitting subject references in a Veo bridge", () => {
    const neutral = omniNeutralRescuePayload({ shot: { ...shot("shot-safe-bridge"), generationPrompt: shot("shot-safe-bridge").generationPrompt! }, specHash: "original" });
    const bridge = veoSafeBridgePayload(neutral);
    expect(bridge.providerModelId).toBe("veo-3.1-fast-generate-preview");
    expect(bridge.omitProviderReferences).toBe(false);
    expect(bridge.omitSubjectReferences).toBe(true);
    expect(bridge.shot.generationPrompt?.prompt).toContain("CINEFORGE VEO SAFE BRIDGE");
    expect(providerAudioContext(bridge.shot.generationPrompt!.prompt, neutral.shot.audioContext)?.dialogue).toEqual([]);
    expect(veoSafeBridgePayload(bridge)).toEqual(bridge);
    const legacy = { ...bridge, shot: { ...bridge.shot, generationPrompt: { ...bridge.shot.generationPrompt!, prompt: bridge.shot.generationPrompt!.prompt.replace("SAFE FICTIONAL PRODUCTION FRAME. ", "") } } };
    expect(veoSafeBridgePayload(legacy).shot.generationPrompt?.prompt).toContain("SAFE FICTIONAL PRODUCTION FRAME");
  });

  it("removes sensitive names, props, references and dialogue from a neutral rescue request only", () => {
    const plannedShot = shot("shot-neutral-context");
    const continuity = {
      ...plannedShot.continuity,
      characterStates: {
        "Nick Fury": {
          ...plannedShot.continuity.characterStates["character-elias"],
          heldProps: ["rifle"],
          position: "Mysterio stands beside a Cadillac with a weapon",
        },
      },
      locationState: {
        ...plannedShot.continuity.locationState,
        objectPositions: { Cadillac: "Marvel car beside an armed arrest team" },
      },
      lockedValues: { "Nick Fury.face": "Marvel likeness" },
    };
    const safeContinuity = neutralRescueContinuity(continuity);
    const safeAudio = neutralRescueAudioContext({
      ...plannedShot.audioContext,
      speakers: ["Nick Fury"],
      dialogue: [{ id: "d1", characterId: "Nick Fury", characterName: "Nick Fury", text: "Вы арестованы", delivery: "firm", startSeconds: 0, durationSeconds: 1 }],
    });
    expect(JSON.stringify(safeContinuity)).not.toMatch(/Nick Fury|Mysterio|Marvel|Cadillac|rifle|weapon|arrest/i);
    expect(safeContinuity.requiredReferences).toEqual(["ref-face", "ref-street"]);
    expect(Object.values(safeContinuity.lockedValues)).toContain("the original fictional production likeness");
    expect(safeAudio?.dialogue).toEqual([]);
    expect(safeAudio?.soundEffects).toEqual([]);
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

  it("preserves a chunked Veo operation error instead of reporting missing media", async () => {
    const body = JSON.stringify({ name: "models/veo/operations/failed", done: true, error: { code: 3, message: "Video generation failed." } });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        controller.enqueue(bytes.slice(0, 37));
        controller.enqueue(bytes.slice(37));
        controller.close();
      },
    });
    const parsed = await readVeoOperationResponse(new Response(stream, { headers: { "content-type": "application/json" } }));
    expect(parsed).toEqual({ done: true, error: { code: 3, message: "Video generation failed." } });
  });

  it("does not label every failed precondition as a billing failure", () => {
    expect(normalizeGoogleProviderError({ status: 400, message: "FAILED_PRECONDITION: another precondition" }).code)
      .toBe("GOOGLE_REQUEST_FAILED");
  });

  it("classifies a billing-tier spend limit as quota before billing", () => {
    expect(normalizeGoogleProviderError({ status: 429, message: "RESOURCE_EXHAUSTED: spend limit for billing tier 1" }).code)
      .toBe("GOOGLE_QUOTA_EXHAUSTED");
  });
  it("treats a generic RESOURCE_EXHAUSTED response as a retryable short rate window", () => {
    const normalized = normalizeGoogleProviderError({ status: 429, message: "RESOURCE_EXHAUSTED: requests per minute quota exceeded. Retry in 42 seconds." });
    expect(normalized.code).toBe("GOOGLE_RATE_LIMIT");
    expect(normalized.retryable).toBe(true);
  });

  it("classifies only an explicit depleted Prepay balance as billing", () => {
    expect(normalizeGoogleProviderError({ status: 400, message: "Your prepayment credits are depleted" }).code)
      .toBe("GOOGLE_BILLING_NOT_READY");
    expect(normalizeGoogleProviderError({ status: 400, message: "Billing metadata failed a different precondition" }).code)
      .toBe("GOOGLE_REQUEST_FAILED");
  });

  it("repairs the old cross-model billing fallback without losing the shot beat", () => {
    const plannedShot = { ...shot("shot-billing-repair"), title: "Выход команды", action: "Ник Фьюри и агенты спокойно выходят из машины и подходят к Мистерио." };
    const legacy = veoNeutralRescuePayload({ providerModelId: "gemini-omni-flash-preview", shot: plannedShot, specHash: "original" });
    expect(shouldRestoreLegacyBillingFallback({ payload: legacy })).toBe(true);
    const restored = restoreOmniAfterLegacyBillingFallbackPayload(legacy);
    expect(restored.providerModelId).toBe("gemini-omni-flash-preview");
    expect(restored.shot.generationPrompt?.prompt).toContain("Выход команды");
    expect(restored.shot.generationPrompt?.prompt).toContain("CINEFORGE OMNI NEUTRAL RESCUE");
    expect(restored.shot.generationPrompt?.prompt).not.toContain("CINEFORGE VEO NEUTRAL RESCUE");
    expect(restored.specHash).not.toBe(legacy.specHash);
  });

  it("does not charge a recovered staged video twice", () => {
    expect(generationAccountingCost(1, 0, true)).toBe(0);
    expect(generationAccountingCost(1, 1, true)).toBe(1);
    expect(generationAccountingCost(1, 0, false)).toBe(1);
  });

  it.each([
    ["gemini-omni-flash-preview", 10, 10],
    ["gemini-omni-flash-preview", 30, 10],
    ["gemini-omni-flash-preview", 60, 10],
    ["veo-3.1-generate-preview", 10, 8],
    ["veo-3.1-generate-preview", 30, 8],
    ["veo-3.1-generate-preview", 60, 8],
  ])("plans %s at an exact %i seconds as one linked timeline", (modelId, targetDuration, maximumBeat) => {
    const longShot = { ...shot("shot-1"), durationSeconds: targetDuration };
    const sourceScene = scene([longShot]);
    const plan: MoviePlan = {
      id: "plan-1", projectId: "project-1", createdAt: new Date(0).toISOString(),
      summary: { title: "Test", genre: "Drama", style: "realistic", mood: "calm", durationSeconds: targetDuration, logline: "Test", synopsis: "Test" },
      characters: [character()], locations: [location()], acts: [{ id: "act-1", number: 1, title: "Act", purpose: "Test", startSceneNumber: 1, endSceneNumber: 1 }], scenes: [sourceScene],
    };
    const normalized = normalizeMoviePlanRuntime(plan, modelId);
    const shots = normalized.scenes.flatMap((item) => item.shots);
    expect(shots.every((item) => item.durationSeconds <= maximumBeat)).toBe(true);
    expect(shots.reduce((sum, item) => sum + item.durationSeconds, 0)).toBe(targetDuration);
    for (let index = 1; index < shots.length; index += 1) {
      expect(shots[index].continuity.previousShotId).toBe(shots[index - 1].id);
      expect(shots[index].dependencies).toContain(shots[index - 1].id);
    }
  });

  it("renders a hard cut at another location independently while retaining chronological memory", () => {
    const firstShot = { ...shot("shot-1"), durationSeconds: 5 };
    const secondShot = {
      ...shot("shot-2", ["shot-1"]),
      sceneId: "scene-2",
      durationSeconds: 5,
      continuity: {
        ...shot("shot-2").continuity,
        locationId: "location-office",
        locationState: { ...shot("shot-2").continuity.locationState, timeOfDay: "day", weather: "clear" },
      },
    };
    const firstScene = scene([firstShot]);
    const secondScene = { ...scene([secondShot]), id: "scene-2", number: 2, title: "Hard cut to office", action: "Hard cut to the office after the journey.", continuityRequirements: ["Intentional location and time jump."], locationId: "location-office", timeOfDay: "day", weather: "clear" };
    const plan: MoviePlan = {
      id: "plan-cut", projectId: "project-cut", createdAt: new Date(0).toISOString(),
      summary: { title: "Cut", genre: "Drama", style: "realistic", mood: "calm", durationSeconds: 10, logline: "Cut", synopsis: "Cut" },
      characters: [character()], locations: [location(), location({ id: "location-office", name: "Office", timeOfDay: "day", defaultWeather: "clear" })],
      acts: [{ id: "act-1", number: 1, title: "Act", purpose: "Test", startSceneNumber: 1, endSceneNumber: 2 }], scenes: [firstScene, secondScene],
    };
    const normalized = normalizeMoviePlanRuntime(plan, "gemini-omni-flash-preview");
    const shots = normalized.scenes.flatMap((item) => item.shots);
    expect(shots[1].continuity.previousShotId).toBe(shots[0].id);
    expect(shots[1].dependencies).not.toContain(shots[0].id);
  });

  it("rejects an unexplained location reset and carries the physical world into the next shot", () => {
    const firstShot = shot("shot-1");
    const driftedShot = {
      ...shot("shot-2"),
      sceneId: "scene-2",
      continuity: {
        ...shot("shot-2").continuity,
        locationId: "location-airport",
        locationState: { timeOfDay: "day", weather: "clear", lighting: "airport fluorescent", objectPositions: {} },
      },
    };
    const plan: MoviePlan = {
      id: "plan-drift", projectId: "project-drift", createdAt: new Date(0).toISOString(),
      summary: { title: "Drift", genre: "Drama", style: "realistic", mood: "calm", durationSeconds: 16, logline: "Drift", synopsis: "Drift" },
      characters: [character()], locations: [location(), location({ id: "location-airport", name: "Airport" })],
      acts: [{ id: "act-1", number: 1, title: "Act", purpose: "Test", startSceneNumber: 1, endSceneNumber: 2 }],
      scenes: [scene([firstShot]), { ...scene([driftedShot]), id: "scene-2", number: 2, locationId: "location-airport", timeOfDay: "day", weather: "clear", title: "Another angle", action: "The conversation continues from the same instant." }],
    };
    const shots = normalizeMoviePlanRuntime(plan, "gemini-omni-flash-preview").scenes.flatMap((item) => item.shots);
    expect(shots[1].dependencies).toContain(shots[0].id);
    expect(shots[1].continuity.locationId).toBe("location-street");
    expect(shots[1].continuity.locationState).toMatchObject({ timeOfDay: "night", weather: "light snow", objectPositions: { phoneBooth: "north corner" } });
  });

  it("builds an exact previous-endpoint contract and preserves locked physical state", () => {
    const before = shot("shot-before").continuity;
    const proposed = {
      ...before,
      characterStates: { ...before.characterStates, "character-elias": { ...before.characterStates["character-elias"], wardrobeId: "random-costume", position: "north curb" } },
      locationState: { ...before.locationState, objectPositions: {} },
    };
    const carried = carryPhysicalWorldForward(before, proposed, "Элиас продолжает разговор.");
    expect(carried.characterStates["character-elias"].wardrobeId).toBe("coat");
    expect(carried.locationState.objectPositions.phoneBooth).toBe("north corner");
    const contract = physicalTransitionContract({ action: "Элиас идёт к северному бордюру", previous: before, current: carried, continuousBoundary: true });
    expect(contract).toContain("START STATE (exact previous endpoint)");
    expect(contract).toContain("PERSISTENT OBJECTS");
    expect(contract).toContain("visible, continuous and physically reachable motion");
  });

  it("turns Mysterio into a stable recognizable costume specification in a safe retry", () => {
    const planned = shot("shot-mysterio");
    const rescued = omniNeutralRescuePayload({
      shot: { ...planned, action: "Мистерио входит в помещение", generationPrompt: planned.generationPrompt! },
      specHash: "mysterio-original",
    });
    expect(rescued.shot.generationPrompt?.prompt).toContain("emerald segmented armor");
    expect(rescued.shot.generationPrompt?.prompt).toContain("opaque glowing glass fishbowl helmet");
    expect(rescued.shot.generationPrompt?.prompt).not.toContain("adult man in a green and burgundy theatrical outfit");
  });
});
