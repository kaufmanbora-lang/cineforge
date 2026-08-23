export type Resolution = "preview" | "720p" | "1080p" | "4k";
export type AspectRatio = "16:9" | "9:16";

export interface VideoModelCapabilities {
  id: string;
  provider: "google";
  displayName: string;
  family: "omni" | "veo";
  lifecycle: "preview" | "stable";
  endpointKind: "interactions" | "generate-videos";
  /** Resolutions a user can receive from the Movie Engine. */
  resolutions: Resolution[];
  /** Resolutions returned natively by the provider rather than at export. */
  nativeResolutions: Resolution[];
  aspectRatios: AspectRatio[];
  durationsSeconds: number[];
  nativeAudio: boolean;
  referenceImages: number;
  referenceVideo: boolean;
  firstFrame: boolean;
  lastFrame: boolean;
  extension: boolean;
  conversationalEditing: boolean;
  pricePerSecondUsd: Partial<Record<Resolution, number>>;
  notes: string[];
  sourceCheckedAt: string;
}

export const GOOGLE_VIDEO_MODELS: Readonly<Record<string, VideoModelCapabilities>> = {
  "gemini-omni-flash-preview": {
    id: "gemini-omni-flash-preview",
    provider: "google",
    displayName: "Gemini Omni Flash",
    family: "omni",
    lifecycle: "preview",
    endpointKind: "interactions",
    // Omni does not expose a resolution control. CineForge keeps its fast
    // native response and can produce an honest 1080p/4K master at export.
    resolutions: ["preview", "720p", "1080p", "4k"],
    nativeResolutions: ["preview", "720p"],
    aspectRatios: ["16:9", "9:16"],
    // Omni does not currently expose a durationSeconds API field. Five-second
    // production beats keep requested runtimes accurate when it returns its
    // common short clip; the exact total is enforced by the Movie Engine.
    durationsSeconds: [5],
    nativeAudio: true,
    referenceImages: 6,
    referenceVideo: false,
    firstFrame: true,
    lastFrame: false,
    extension: false,
    conversationalEditing: true,
    pricePerSecondUsd: { preview: 0.1, "720p": 0.1, "1080p": 0.1, "4k": 0.1 },
    notes: [
      "Preview model; availability depends on the Google project.",
      "Uploaded-video editing is unavailable in the EEA, Switzerland and the UK.",
      "Voice editing, interpolation and extension are not supported.",
      "Clip duration is guided by prompt timecodes; the API has no explicit duration parameter.",
      "1080p and 4K are Movie Engine export resolutions; Omni does not expose a native resolution parameter.",
    ],
    sourceCheckedAt: "2026-08-23",
  },
  "veo-3.1-generate-preview": {
    id: "veo-3.1-generate-preview",
    provider: "google",
    displayName: "Veo 3.1",
    family: "veo",
    lifecycle: "preview",
    endpointKind: "generate-videos",
    resolutions: ["preview", "720p", "1080p", "4k"],
    nativeResolutions: ["preview", "720p", "1080p", "4k"],
    aspectRatios: ["16:9", "9:16"],
    durationsSeconds: [4, 6, 8],
    nativeAudio: true,
    referenceImages: 3,
    referenceVideo: true,
    firstFrame: true,
    lastFrame: true,
    extension: true,
    conversationalEditing: false,
    pricePerSecondUsd: { preview: 0.4, "720p": 0.4, "1080p": 0.4, "4k": 0.6 },
    notes: ["1080p, 4K, reference images and extension require 8-second generations."],
    sourceCheckedAt: "2026-08-23",
  },
  "veo-3.1-fast-generate-preview": {
    id: "veo-3.1-fast-generate-preview",
    provider: "google",
    displayName: "Veo 3.1 Fast",
    family: "veo",
    lifecycle: "preview",
    endpointKind: "generate-videos",
    resolutions: ["preview", "720p", "1080p", "4k"],
    nativeResolutions: ["preview", "720p", "1080p", "4k"],
    aspectRatios: ["16:9", "9:16"],
    durationsSeconds: [4, 6, 8],
    nativeAudio: true,
    referenceImages: 3,
    referenceVideo: true,
    firstFrame: true,
    lastFrame: true,
    extension: true,
    conversationalEditing: false,
    pricePerSecondUsd: { preview: 0.1, "720p": 0.1, "1080p": 0.12, "4k": 0.3 },
    notes: ["1080p, 4K, reference images and extension require 8-second generations."],
    sourceCheckedAt: "2026-08-23",
  },
  "veo-3.1-lite-generate-preview": {
    id: "veo-3.1-lite-generate-preview",
    provider: "google",
    displayName: "Veo 3.1 Lite",
    family: "veo",
    lifecycle: "preview",
    endpointKind: "generate-videos",
    resolutions: ["preview", "720p", "1080p"],
    nativeResolutions: ["preview", "720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    durationsSeconds: [4, 6, 8],
    nativeAudio: true,
    referenceImages: 0,
    referenceVideo: false,
    firstFrame: true,
    lastFrame: true,
    extension: false,
    conversationalEditing: false,
    pricePerSecondUsd: { preview: 0.05, "720p": 0.05, "1080p": 0.08 },
    notes: ["4K output and reference images are not supported.", "1080p requires 8 seconds."],
    sourceCheckedAt: "2026-08-23",
  },
};

export function getVideoModel(modelId: string): VideoModelCapabilities {
  const model = GOOGLE_VIDEO_MODELS[modelId];
  if (!model) throw new Error(`Unsupported video model: ${modelId}`);
  return model;
}

export function getAllowedDurations(modelId: string, resolution: Resolution): number[] {
  const model = getVideoModel(modelId);
  // Interactions currently has no duration/resolution fields. Resolution is
  // applied later by the Movie Engine and must not change Omni shot planning.
  if (model.family === "omni") return [...model.durationsSeconds];
  if (resolution === "1080p" || resolution === "4k") return [8];
  return [...model.durationsSeconds];
}

export function isNativeResolution(modelId: string, resolution: Resolution): boolean {
  return getVideoModel(modelId).nativeResolutions.includes(resolution);
}

export function normalizeResolution(modelId: string, requested: Resolution): Resolution {
  const model = getVideoModel(modelId);
  if (model.resolutions.includes(requested)) return requested;
  return model.resolutions.includes("720p") ? "720p" : model.resolutions[0];
}
