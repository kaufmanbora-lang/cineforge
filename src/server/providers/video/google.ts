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
        const normalized = normalizeGoogleProviderError({ status: raw.error.code, message: raw.error.message });
        return {
          ...operation,
          state: "failed",
          error: normalized,
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
        background: false,
        stream: false,
        store: request.fastMode ? false : true,
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
  for (let attempt = 0; attempt < 72; attempt += 1) {
    const response = await fetch(uri, { headers: { "x-goog-api-key": apiKey }, redirect: "follow" });
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (![400, 404, 409, 425].includes(response.status)) throw await googleHttpError(response);
    const fileName = googleFileName(uri);
    if (!fileName) throw await googleHttpError(response);
    const metadata = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
      headers: { "x-goog-api-key": apiKey },
      cache: "no-store",
    });
    if (!metadata.ok) throw await googleHttpError(metadata);
    const payload = await metadata.json() as { state?: string | { name?: string }; error?: { message?: string } };
    const state = typeof payload.state === "string" ? payload.state : payload.state?.name;
    if (state === "FAILED") throw new Error(payload.error?.message ?? "Google could not process the generated video file.");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
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
  if (/billing|prepay|prepaid|payment|credit balance|no credits|failed_precondition/.test(probe)) {
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
