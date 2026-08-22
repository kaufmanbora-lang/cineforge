import { GoogleGenAI } from "@google/genai";
import { getVideoModel, GOOGLE_VIDEO_MODELS } from "@/domain/video-models";
import type { ProviderOperation, VideoGenerationRequest, VideoModelAdapter } from "./types";

interface GoogleModelResource {
  name: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  supportedActions?: string[];
}

export async function discoverGoogleModels(apiKey: string): Promise<GoogleModelResource[]> {
  const all: GoogleModelResource[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, { headers: { "x-goog-api-key": apiKey }, cache: "no-store" });
    if (!response.ok) throw await googleHttpError(response);
    const payload = await response.json() as { models?: GoogleModelResource[]; nextPageToken?: string };
    all.push(...(payload.models ?? []));
    pageToken = payload.nextPageToken;
  } while (pageToken);
  return all;
}

export async function availableGoogleVideoModels(apiKey: string) {
  const discovered = await discoverGoogleModels(apiKey);
  const ids = new Set(discovered.map((model) => model.name.replace(/^models\//, "")));
  const known = Object.values(GOOGLE_VIDEO_MODELS).map((model) => ({ ...model, available: ids.has(model.id), selectable: true }));
  const discoveredVideoModels = discovered
    .map((model) => ({ ...model, id: model.name.replace(/^models\//, "") }))
    .filter((model) => !GOOGLE_VIDEO_MODELS[model.id])
    .filter((model) => /veo|video|omni/i.test(`${model.id} ${model.displayName ?? ""} ${model.description ?? ""}`))
    .map((model) => ({
      id: model.id,
      displayName: model.displayName ?? model.id,
      provider: "google" as const,
      family: "discovered" as const,
      lifecycle: "unknown" as const,
      endpointKind: "unknown" as const,
      resolutions: [] as string[],
      aspectRatios: [] as string[],
      durationsSeconds: [] as number[],
      nativeAudio: false,
      referenceImages: 0,
      referenceVideo: false,
      firstFrame: false,
      lastFrame: false,
      extension: false,
      conversationalEditing: false,
      pricePerSecondUsd: {},
      notes: ["Discovered from the account Models API. Selection stays disabled until a verified capability adapter is registered."],
      sourceCheckedAt: new Date().toISOString().slice(0, 10),
      available: true,
      selectable: false,
    }));
  return [...known, ...discoveredVideoModels];
}

export class GoogleVeoAdapter implements VideoModelAdapter {
  readonly capabilities;
  constructor(modelId: string) {
    this.capabilities = getVideoModel(modelId);
    if (this.capabilities.family !== "veo") throw new Error(`${modelId} is not a Veo model.`);
  }

  async start(request: VideoGenerationRequest, apiKey: string): Promise<ProviderOperation> {
    const ai = new GoogleGenAI({ apiKey });
    try {
      const primaryImage = request.references.find((reference) => reference.role === "first-frame");
      const lastFrame = request.references.find((reference) => reference.role === "last-frame");
      const subjectReferences = request.references.filter((reference) => reference.role === "subject" || reference.role === "style");
      const operation = await ai.models.generateVideos({
        model: request.modelId,
        prompt: request.prompt,
        image: primaryImage ? imageValue(primaryImage) : undefined,
        config: {
          aspectRatio: request.aspectRatio,
          resolution: request.resolution === "preview" ? "720p" : request.resolution,
          durationSeconds: request.durationSeconds,
          seed: request.seed ?? undefined,
          negativePrompt: request.negativeDirectives.join(", "),
          numberOfVideos: 1,
          lastFrame: lastFrame ? imageValue(lastFrame) : undefined,
          referenceImages: subjectReferences.map((reference) => ({ image: imageValue(reference), referenceType: "asset" })),
        },
      } as never);
      const raw = operation as unknown as { name?: string; done?: boolean };
      return {
        provider: "google",
        modelId: request.modelId,
        operationId: raw.name ?? `veo-inline-${Date.now()}`,
        // Always resolve through the official operation poller so both delayed and
        // immediately-completed operations use the same output extraction path.
        state: "pending",
      };
    } catch (error) {
      return failedOperation(request.modelId, error);
    }
  }

  async poll(operation: ProviderOperation, apiKey: string): Promise<ProviderOperation> {
    if (operation.state !== "pending") return operation;
    const ai = new GoogleGenAI({ apiKey });
    try {
      const polled = await ai.operations.getVideosOperation({
        operation: { name: operation.operationId } as never,
      });
      const raw = polled as unknown as {
        done?: boolean;
        error?: { code?: number; message?: string };
        response?: { generatedVideos?: Array<{ video?: { uri?: string; videoBytes?: string; mimeType?: string } }> };
      };
      if (raw.error) {
        return {
          ...operation,
          state: "failed",
          error: { code: String(raw.error.code ?? "GOOGLE_ERROR"), message: raw.error.message ?? "Video generation failed", retryable: isRetryableCode(raw.error.code) },
        };
      }
      if (!raw.done) return operation;
      const video = raw.response?.generatedVideos?.[0]?.video;
      if (!video) throw new Error("Google completed the operation without a video output.");
      const bytes = video.videoBytes
        ? Buffer.from(video.videoBytes, "base64")
        : await downloadGoogleFile(video.uri, apiKey);
      return {
        ...operation,
        state: "completed",
        progress: 100,
        output: { bytes, mimeType: video.mimeType ?? "video/mp4", providerUri: video.uri },
      };
    } catch (error) {
      return failedOperation(operation.modelId, error, operation.operationId);
    }
  }
}

export class GoogleOmniAdapter implements VideoModelAdapter {
  readonly capabilities = getVideoModel("gemini-omni-flash-preview");

  async start(request: VideoGenerationRequest, apiKey: string): Promise<ProviderOperation> {
    const ai = new GoogleGenAI({ apiKey });
    try {
      const input: Array<Record<string, unknown>> = request.references.map((reference) => ({
        type: "image",
        data: reference.data,
        mime_type: reference.mimeType,
      }));
      input.push({ type: "text", text: request.editInstruction ?? request.prompt });
      const interaction = await ai.interactions.create({
        model: request.modelId,
        input: request.references.length || request.editInstruction ? input : request.prompt,
        previous_interaction_id: request.previousInteractionId,
        response_format: {
          type: "video",
          aspect_ratio: request.aspectRatio,
          duration: `${request.durationSeconds}s`,
          resolution: request.resolution === "preview" ? "720p" : request.resolution,
          delivery: "uri",
        },
        generation_config: {
          video_config: {
            task: request.editInstruction ? "edit" : request.references.length ? "reference_to_video" : "text_to_video",
          },
        },
      } as never);
      const raw = interaction as unknown as {
        id?: string;
        output_video?: { data?: string; uri?: string; mime_type?: string };
        outputVideo?: { data?: string; uri?: string; mimeType?: string };
      };
      const video = raw.output_video ?? raw.outputVideo;
      if (!video) throw new Error("Gemini Omni returned no video output.");
      const bytes = video.data ? Buffer.from(video.data, "base64") : await downloadGoogleFile(video.uri, apiKey);
      const videoRecord = video as { data?: string; uri?: string; mime_type?: string; mimeType?: string };
      return {
        provider: "google",
        modelId: request.modelId,
        operationId: raw.id ?? `omni-${Date.now()}`,
        state: "completed",
        progress: 100,
        output: { bytes, mimeType: videoRecord.mime_type ?? videoRecord.mimeType ?? "video/mp4", providerUri: video.uri, interactionId: raw.id },
      };
    } catch (error) {
      return failedOperation(request.modelId, error);
    }
  }

  async poll(operation: ProviderOperation): Promise<ProviderOperation> {
    return operation;
  }
}

export function googleVideoAdapter(modelId: string): VideoModelAdapter {
  return modelId.startsWith("gemini-omni") ? new GoogleOmniAdapter() : new GoogleVeoAdapter(modelId);
}

function imageValue(reference: { data: string; mimeType: string }) {
  return { imageBytes: reference.data, mimeType: reference.mimeType };
}

async function downloadGoogleFile(uri: string | undefined, apiKey: string): Promise<Uint8Array> {
  if (!uri) throw new Error("Google did not provide inline video bytes or a download URI.");
  const response = await fetch(uri, { headers: { "x-goog-api-key": apiKey }, redirect: "follow" });
  if (!response.ok) throw await googleHttpError(response);
  return new Uint8Array(await response.arrayBuffer());
}

async function googleHttpError(response: Response): Promise<Error> {
  const text = await response.text();
  const error = new Error(`Google API ${response.status}: ${text.slice(0, 500)}`);
  Object.assign(error, { status: response.status });
  return error;
}

function failedOperation(modelId: string, error: unknown, operationId = `failed-${Date.now()}`): ProviderOperation {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : undefined;
  return {
    provider: "google",
    modelId,
    operationId,
    state: "failed",
    error: {
      code: status ? String(status) : "GOOGLE_SDK_ERROR",
      message: error instanceof Error ? error.message : "Unknown Google API error",
      retryable: status ? isRetryableCode(status) : true,
    },
  };
}

function isRetryableCode(code: number | undefined): boolean {
  return code === 408 || code === 429 || (Boolean(code) && code! >= 500);
}
