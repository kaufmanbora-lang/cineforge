import { GoogleGenAI } from "@google/genai";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
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

export async function diagnoseGoogleConnection(apiKey: string) {
  const models = await availableGoogleVideoModels(apiKey);
  const availableModelIds = models.filter((model) => model.available && model.selectable !== false).map((model) => model.id);
  return {
    connected: true as const,
    keyValid: true as const,
    modelCatalogAccessible: true as const,
    availableModelIds,
    billing: {
      status: "not_exposed_by_api" as const,
      balanceUsd: null,
      message: "Ключ действителен и каталог моделей доступен. Google не передаёт остаток предоплаченного баланса через Gemini Models API; готовность оплаты окончательно проверяется при первом запросе генерации.",
      billingUrl: "https://aistudio.google.com/billing",
      usageUrl: "https://aistudio.google.com/usage",
      spendUrl: "https://aistudio.google.com/spend",
    },
    models,
  };
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
        config: googleVeoConfig(request, lastFrame, subjectReferences),
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
    try {
      const operationName = operation.operationId.replace(/^\/?v1beta\//, "");
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${operationName}`, {
        headers: { "x-goog-api-key": apiKey },
        cache: "no-store",
      });
      if (!response.ok) throw await googleHttpError(response);
      const raw = await readVeoOperationResponse(response) as {
        done?: boolean;
        error?: { code?: number; message?: string };
        response?: {
          generatedVideos?: Array<{ video?: VeoVideoOutput }>;
          generateVideoResponse?: {
            generatedSamples?: Array<{ video?: VeoVideoOutput }>;
            raiMediaFilteredCount?: number;
            raiMediaFilteredReasons?: string[];
          };
        };
      };
      if (raw.error) {
        const normalized = normalizeGoogleProviderError({ status: raw.error.code, message: raw.error.message });
        return {
          ...operation,
          state: "failed",
          error: normalized,
        };
      }
      if (!raw.done) return operation;
      const video = extractVeoVideo(raw);
      if (!video) {
        const reasons = raw.response?.generateVideoResponse?.raiMediaFilteredReasons?.join("; ");
        if (raw.response?.generateVideoResponse?.raiMediaFilteredCount) {
          throw Object.assign(new Error(reasons || "Google blocked the generated video for safety reasons."), { code: "GOOGLE_MODERATION" });
        }
        throw new Error("Google completed the operation without a video output.");
      }
      const bytes = video.videoBytes ? Buffer.from(video.videoBytes, "base64") : undefined;
      if (!bytes && !video.uri && !video.localFilePath) {
        throw new Error(`Google completed the operation without downloadable video media. Video fields: ${Object.keys(video).sort().join(", ") || "none"}.`);
      }
      return {
        ...operation,
        state: "completed",
        progress: 100,
        output: {
          bytes,
          localFilePath: video.localFilePath,
          byteSize: video.byteSize,
          checksum: video.checksum,
          mimeType: video.mimeType ?? "video/mp4",
          providerUri: video.uri,
        },
      };
    } catch (error) {
      return failedOperation(operation.modelId, error, operation.operationId);
    }
  }
}

interface VeoVideoOutput {
  uri?: string;
  videoBytes?: string;
  encodedVideo?: string;
  bytesBase64Encoded?: string;
  mimeType?: string;
  encoding?: string;
  localFilePath?: string;
  byteSize?: number;
  checksum?: string;
}

export async function readVeoOperationResponse(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 0 && contentLength <= 8 * 1024 * 1024) return response.json();
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let window = "";
  let done = false;
  let uri: string | undefined;
  let mimeType: string | undefined;
  let raiMediaFilteredCount = 0;
  let raiMediaFilteredReasons: string[] = [];
  let readingInlineVideo = false;
  let inlineFinished = false;
  let base64Carry = "";
  let byteSize = 0;
  const responseFields = new Set<string>();
  const stringPrefixes = new Map<string, string>();
  const hash = createHash("sha256");
  const localFilePath = join(tmpdir(), `cineforge-veo-${randomUUID()}.mp4`);
  let output: ReturnType<typeof createWriteStream> | undefined;

  const inspectJson = (value: string) => {
    done ||= /"done"\s*:\s*true/.test(value);
    for (const match of value.matchAll(/"([A-Za-z@][A-Za-z0-9_@.-]{0,99})"\s*:/g)) responseFields.add(match[1]);
    for (const match of value.matchAll(/"([A-Za-z@][A-Za-z0-9_@.-]{0,99})"\s*:\s*"([^"\\]{0,48})/g)) {
      if (!stringPrefixes.has(match[1])) stringPrefixes.set(match[1], match[2]);
    }
    const uriMatch = value.match(/"(?:uri|videoUri|video_uri|downloadUri|download_uri)"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const mimeMatch = value.match(/"(?:mimeType|mime_type|encoding)"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const filteredCountMatch = value.match(/"raiMediaFilteredCount"\s*:\s*(\d+)/);
    const filteredReasonsMatch = value.match(/"raiMediaFilteredReasons"\s*:\s*(\[[\s\S]*?\])/);
    if (uriMatch) uri = JSON.parse(`"${uriMatch[1]}"`) as string;
    if (mimeMatch) mimeType = JSON.parse(`"${mimeMatch[1]}"`) as string;
    if (filteredCountMatch) raiMediaFilteredCount = Number(filteredCountMatch[1]);
    if (filteredReasonsMatch) {
      try { raiMediaFilteredReasons = JSON.parse(filteredReasonsMatch[1]) as string[]; } catch { /* incomplete streaming window */ }
    }
  };
  const writeBase64 = async (value: string, final = false) => {
    const compact = `${base64Carry}${value}`.replace(/\s+/g, "");
    const usableLength = final ? compact.length : compact.length - (compact.length % 4);
    base64Carry = compact.slice(usableLength);
    if (!usableLength) return;
    const bytes = Buffer.from(compact.slice(0, usableLength), "base64");
    if (!bytes.length) return;
    output ??= createWriteStream(localFilePath, { flags: "wx" });
    hash.update(bytes);
    byteSize += bytes.length;
    if (!output.write(bytes)) await once(output, "drain");
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      window += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        if (readingInlineVideo) {
          const closingQuote = window.indexOf('"');
          if (closingQuote === -1) {
            await writeBase64(window);
            window = "";
            break;
          }
          await writeBase64(window.slice(0, closingQuote), true);
          window = window.slice(closingQuote + 1);
          readingInlineVideo = false;
          inlineFinished = true;
          continue;
        }
        inspectJson(window);
        if (done && uri) {
          await reader.cancel();
          return { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri, mimeType } }] } } };
        }
        // Gemini Developer API uses `encodedVideo`; the SDK maps that field to
        // `videoBytes`. Vertex responses use `bytesBase64Encoded`.
        const inlineMatch = /"(?:encodedVideo|videoBytes|bytesBase64Encoded)"\s*:\s*"/.exec(window);
        const genericInlineMatch = inlineMatch ?? /"[A-Za-z][A-Za-z0-9_]{0,79}"\s*:\s*"(?=(?:data:video(?:\\?\/)[^,]{0,80},)?[A-Za-z0-9+/_-]{128})/.exec(window);
        if (genericInlineMatch) {
          inspectJson(window.slice(0, genericInlineMatch.index));
          window = window.slice(genericInlineMatch.index + genericInlineMatch[0].length);
          window = window.replace(/^data:video(?:\\?\/)[^,]{0,80},/, "");
          readingInlineVideo = true;
          output ??= createWriteStream(localFilePath, { flags: "wx" });
          continue;
        }
        if (window.length > 128 * 1024) window = window.slice(-64 * 1024);
        break;
      }
    }
    window += decoder.decode();
    inspectJson(window);
    if (readingInlineVideo) throw new Error("Google returned an incomplete inline video payload.");
    if (!done) return { done: false };
    if (uri) return { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri, mimeType } }] } } };
    if (raiMediaFilteredCount > 0) {
      return { done: true, response: { generateVideoResponse: { generatedSamples: [], raiMediaFilteredCount, raiMediaFilteredReasons } } };
    }
    if (!inlineFinished || !output || byteSize <= 0) {
      const prefixes = [...stringPrefixes].slice(0, 16).map(([key, value]) => `${key}=${value.slice(0, 24)}`).join(", ");
      throw new Error(`Google completed the operation without downloadable video media. JSON fields: ${[...responseFields].slice(0, 48).join(", ") || "none"}. String prefixes: ${prefixes || "none"}.`);
    }
    output.end();
    await once(output, "finish");
    return {
      done: true,
      response: {
        generateVideoResponse: {
          generatedSamples: [{ video: { localFilePath, byteSize, checksum: hash.digest("hex"), mimeType: mimeType ?? "video/mp4" } }],
        },
      },
    };
  } catch (error) {
    output?.destroy();
    await rm(localFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function extractVeoVideo(raw: {
  response?: {
    generatedVideos?: Array<{ video?: VeoVideoOutput }>;
    generateVideoResponse?: { generatedSamples?: Array<{ video?: VeoVideoOutput }> };
  };
}) {
  const video = raw.response?.generatedVideos?.[0]?.video ?? raw.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
  if (!video) return undefined;
  // Small REST responses are parsed as raw JSON before the SDK mapping layer,
  // where MLDev names the fields `encodedVideo` and `encoding`.
  const unknownInlineVideo = Object.entries(video).find(([, value]) =>
    typeof value === "string" && value.length >= 128 && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
  )?.[1] as string | undefined;
  return {
    ...video,
    videoBytes: video.videoBytes ?? video.encodedVideo ?? video.bytesBase64Encoded ?? unknownInlineVideo,
    mimeType: video.mimeType ?? video.encoding,
  };
}

export function googleVeoConfig(
  request: VideoGenerationRequest,
  lastFrame?: VideoGenerationRequest["references"][number],
  subjectReferences: VideoGenerationRequest["references"] = [],
) {
  const supportedReferenceImages = subjectReferences.length >= 2
    ? subjectReferences.slice(0, 3).map((reference) => ({ image: imageValue(reference), referenceType: "asset" }))
    : undefined;
  return {
    aspectRatio: request.aspectRatio,
    resolution: request.resolution === "preview" ? "720p" : request.resolution,
    durationSeconds: request.durationSeconds,
    negativePrompt: request.negativeDirectives.join(", "),
    numberOfVideos: 1,
    lastFrame: lastFrame ? imageValue(lastFrame) : undefined,
    referenceImages: supportedReferenceImages,
  };
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
      const statefulEdit = Boolean(request.previousInteractionId && request.editInstruction);
      const videoTask = googleOmniVideoTask(request);
      const interaction = await ai.interactions.create({
        model: request.modelId,
        // A stateful edit already has the original generated video in its
        // interaction history. Supplying reference images or video_config at
        // the same time is rejected by the official API.
        input: statefulEdit ? request.editInstruction! : request.references.length ? input : request.prompt,
        previous_interaction_id: statefulEdit ? request.previousInteractionId : undefined,
        // Unary generation is the lowest-latency official Interactions path.
        // URI video delivery requires storage even in Fast Draft mode.
        background: false,
        stream: false,
        store: googleOmniShouldStore(request),
        response_format: {
          type: "video",
          aspect_ratio: request.aspectRatio,
          // Official URI delivery prevents a large base64 MP4 from occupying
          // the worker heap and is supported for every Omni video response.
          delivery: "uri",
        },
        generation_config: videoTask ? { video_config: { task: videoTask } } : undefined,
      } as never);
      const raw = interaction as unknown as {
        id?: string;
        output_video?: { data?: string; uri?: string; mime_type?: string };
        outputVideo?: { data?: string; uri?: string; mimeType?: string };
        steps?: Array<{ content?: Array<{ type?: string; data?: string; uri?: string; mime_type?: string; mimeType?: string }> }>;
        outputs?: Array<{ content?: Array<{ type?: string; data?: string; uri?: string; mime_type?: string; mimeType?: string }> }>;
      };
      // Interactions API currently returns generated media as a video content
      // part inside `steps`. Keep the named fields and `outputs` fallback for
      // SDK/API revisions, but parse the real response shape used in production.
      const video = raw.output_video ?? raw.outputVideo ?? extractOmniVideo(raw);
      if (!video) throw new Error("Gemini Omni returned no video output.");
      if (video.uri) await waitForGoogleFileActive(video.uri, apiKey);
      const bytes = video.data ? Buffer.from(video.data, "base64") : undefined;
      if (!bytes && !video.uri) throw new Error("Gemini Omni returned no downloadable video media.");
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

export function googleOmniVideoTask(request: Pick<VideoGenerationRequest, "previousInteractionId" | "editInstruction" | "references">): "edit" | "reference_to_video" | "text_to_video" | undefined {
  if (request.previousInteractionId && request.editInstruction) return undefined;
  if (request.editInstruction) return "edit";
  return request.references.length ? "reference_to_video" : "text_to_video";
}

export function googleOmniShouldStore(request: Pick<VideoGenerationRequest, "fastMode" | "previousInteractionId" | "editInstruction">): true {
  // Google rejects delivery="uri" together with store=false. Keeping URI
  // delivery avoids loading a large base64 MP4 into the 512 MB worker heap.
  void request;
  return true;
}

export function extractOmniVideo(raw: {
  steps?: Array<{ content?: Array<{ type?: string; data?: string; uri?: string; mime_type?: string; mimeType?: string }> }>;
  outputs?: Array<{ content?: Array<{ type?: string; data?: string; uri?: string; mime_type?: string; mimeType?: string }> }>;
}): { data?: string; uri?: string; mime_type?: string; mimeType?: string } | undefined {
  const content = [...(raw.steps ?? []), ...(raw.outputs ?? [])].flatMap((item) => item.content ?? []);
  return content.find((part) => part.type === "video" && Boolean(part.data || part.uri));
}

export function googleVideoAdapter(modelId: string): VideoModelAdapter {
  return modelId.startsWith("gemini-omni") ? new GoogleOmniAdapter() : new GoogleVeoAdapter(modelId);
}

function imageValue(reference: { data: string; mimeType: string }) {
  return { imageBytes: reference.data, mimeType: reference.mimeType };
}

async function waitForGoogleFileActive(uri: string, apiKey: string): Promise<void> {
  const fileName = googleFileName(uri);
  if (!fileName) return;
  for (let attempt = 0; attempt < 72; attempt += 1) {
    const metadata = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
      headers: { "x-goog-api-key": apiKey },
      cache: "no-store",
    });
    if (!metadata.ok) {
      if ([400, 404, 409, 425].includes(metadata.status)) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      throw await googleHttpError(metadata);
    }
    const payload = await metadata.json() as { state?: string | { name?: string }; error?: { message?: string } };
    const state = typeof payload.state === "string" ? payload.state : payload.state?.name;
    if (state === "ACTIVE" || !state) return;
    if (state === "FAILED") throw new Error(payload.error?.message ?? "Google could not process the generated video file.");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw Object.assign(new Error("Google video file processing timed out."), { status: 408, code: "GOOGLE_TIMEOUT" });
}

function googleFileName(uri: string): string | null {
  const match = uri.match(/(?:\/v1beta\/)?(files\/[a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

async function googleHttpError(response: Response): Promise<Error> {
  const text = await response.text();
  const normalized = normalizeGoogleProviderError({ status: response.status, message: text.slice(0, 1_500) });
  const error = new Error(normalized.message);
  Object.assign(error, { status: response.status, code: normalized.code, providerMessage: text.slice(0, 1_500) });
  return error;
}

function failedOperation(modelId: string, error: unknown, operationId = `failed-${Date.now()}`): ProviderOperation {
  const normalized = normalizeGoogleProviderError(error);
  return {
    provider: "google",
    modelId,
    operationId,
    state: "failed",
    error: normalized,
  };
}

export function normalizeGoogleProviderError(error: unknown): { code: string; message: string; retryable: boolean; status?: number } {
  const record = typeof error === "object" && error ? error as Record<string, unknown> : {};
  const rawStatus = record.status ?? record.statusCode ?? record.httpStatus ?? (typeof record.code === "number" ? record.code : undefined);
  const status = rawStatus === undefined ? undefined : Number(rawStatus);
  const rawMessage = error instanceof Error ? error.message : typeof record.message === "string" ? record.message : String(error ?? "");
  const probe = `${String(record.code ?? "")} ${rawMessage}`.toLowerCase();

  if (status === 401 || /api[_ -]?key.*(invalid|expired)|unauthenticated|authentication/.test(probe)) {
    return { code: "GOOGLE_AUTHENTICATION", status, retryable: false, message: "Google отклонил API-ключ. Создайте новый ключ Gemini API и замените его в разделе «Настройки → API»." };
  }
  if (/billing|prepay|prepaid|payment|credit balance|no credits/.test(probe)) {
    return { code: "GOOGLE_BILLING_NOT_READY", status, retryable: false, message: "Оплата Gemini API ещё не активна для проекта этого ключа. Проверьте положительный баланс Prepay и привязку billing именно к проекту ключа в Google AI Studio." };
  }
  if (status === 403 || /permission_denied|access restricted|permission/.test(probe)) {
    return { code: "GOOGLE_PERMISSION_DENIED", status, retryable: false, message: "У проекта Google нет доступа к выбранной видеомодели. Проверьте платный уровень, регион, права проекта и ограничения ключа." };
  }
  if (status === 404 || /model_not_found|not found/.test(probe)) {
    return { code: "GOOGLE_MODEL_UNAVAILABLE", status, retryable: false, message: "Выбранная видеомодель недоступна этому Google-проекту. Выберите другую доступную модель и продолжите с checkpoint." };
  }
  if (status === 429 && /quota|resource_exhausted|daily|balance|квот/.test(probe)) {
    return { code: "GOOGLE_QUOTA_EXHAUSTED", status, retryable: false, message: "Квота или доступный лимит Gemini API исчерпаны. Проект поставлен на паузу и продолжится с незавершённого кадра после восстановления лимита." };
  }
  if (status === 429) {
    return { code: "GOOGLE_RATE_LIMIT", status, retryable: true, message: "Google временно ограничил частоту запросов. CineForge повторит только незавершённый кадр с увеличивающейся задержкой." };
  }
  if (status === 408 || /timeout|deadline_exceeded/.test(probe)) {
    return { code: "GOOGLE_TIMEOUT", status, retryable: true, message: "Google не завершил запрос вовремя. CineForge безопасно повторит только этот кадр." };
  }
  if ((status && status >= 500) || /service_unavailable|api_error|server error/.test(probe)) {
    return { code: "GOOGLE_SERVER_ERROR", status, retryable: true, message: "Видеосервис Google временно недоступен. CineForge повторит запрос с ограниченной автоматической задержкой." };
  }
  if (/safety|moderation|blocked|policy/.test(probe)) {
    return { code: "GOOGLE_MODERATION", status, retryable: false, message: "Google отклонил этот кадр по правилам безопасности. Исправьте только проблемную сцену или её prompt." };
  }
  return { code: "GOOGLE_REQUEST_FAILED", status, retryable: isRetryableCode(status), message: rawMessage ? `Google не выполнил запрос: ${rawMessage.slice(0, 500)}` : "Google не выполнил запрос по неизвестной причине." };
}

function isRetryableCode(code: number | undefined): boolean {
  return code === 408 || code === 429 || (Boolean(code) && code! >= 500);
}
