export type Resolution = "preview" | "720p" | "1080p" | "4k";
export type AspectRatio = "16:9" | "9:16";

export interface VideoModelCapabilities {
  id: string;
  provider: "google";
  displayName: string;
  family: "omni" | "veo";
  lifecycle: "preview" | "stable";
  endpointKind: "interactions" | "generate-videos";
  resolutions: Resolution[];
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
    resolutions: ["preview", "720p"],
    aspectRatios: ["16:9", "9:16"],
    durationsSeconds: [3, 4, 5, 6, 7, 8, 9, 10],
    nativeAudio: true,
    referenceImages: 6,
    referenceVideo: false,
    firstFrame: true,
    lastFrame: false,
    extension: false,
    conversationalEditing: true,
    pricePerSecondUsd: { preview: 0.1, "720p": 0.1 },
    notes: [
      "Preview model; availability depends on the Google project.",
      "Uploaded-video editing is unavailable in the EEA, Switzerland and the UK.",
      "Voice editing, interpolation and extension are not supported.",
    ],
    sourceCheckedAt: "2026-08-22",
  },
  "veo-3.1-generate-preview": {
    id: "veo-3.1-generate-preview",
    provider: "google",
    displayName: "Veo 3.1",
    family: "veo",
    lifecycle: "preview",
    endpointKind: "generate-videos",
    resolutions: ["preview", "720p", "1080p", "4k"],
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
    sourceCheckedAt: "2026-08-22",
  },
  "veo-3.1-fast-generate-preview": {
    id: "veo-3.1-fast-generate-preview",
    provider: "google",
    displayName: "Veo 3.1 Fast",
    family: "veo",
    lifecycle: "preview",
    endpointKind: "generate-videos",
    resolutions: ["preview", "720p", "1080p", "4k"],
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
    sourceCheckedAt: "2026-08-22",
  },
  "veo-3.1-lite-generate-preview": {
    id: "veo-3.1-lite-generate-preview",
    provider: "google",
    displayName: "Veo 3.1 Lite",
    family: "veo",
    lifecycle: "preview",
    endpointKind: "generate-videos",
    resolutions: ["preview", "720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    durationsSeconds: [4, 6, 8],
    nativeAudio: true,
    referenceImages: 3,
    referenceVideo: false,
    firstFrame: true,
    lastFrame: false,
    extension: false,
    conversationalEditing: false,
    pricePerSecondUsd: { preview: 0.05, "720p": 0.05, "1080p": 0.08 },
    notes: ["4K output is not supported.", "1080p and reference images require 8 seconds."],
    sourceCheckedAt: "2026-08-22",
  },
};

export function getVideoModel(modelId: string): VideoModelCapabilities {
  const model = GOOGLE_VIDEO_MODELS[modelId];
  if (!model) throw new Error(`Unsupported video model: ${modelId}`);
  return model;
}

export function getAllowedDurations(modelId: string, resolution: Resolution): number[] {
  const model = getVideoModel(modelId);
  if (resolution === "1080p" || resolution === "4k") return [8];
  return [...model.durationsSeconds];
}

export function normalizeResolution(modelId: string, requested: Resolution): Resolution {
  const model = getVideoModel(modelId);
  if (model.resolutions.includes(requested)) return requested;
  return model.resolutions.includes("720p") ? "720p" : model.resolutions[0];
}
