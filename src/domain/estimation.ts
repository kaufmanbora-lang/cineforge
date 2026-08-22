import { getAllowedDurations, getVideoModel, type Resolution } from "./video-models";

export interface GenerationEstimate {
  shots: number;
  clipSeconds: number;
  videoUsd: number;
  audioUsd: number;
  retriesReserveUsd: number;
  estimatedTotalUsd: number;
  approximate: true;
}

export function estimateGeneration(input: {
  durationSeconds: number;
  modelId: string;
  resolution: Resolution;
  retryReservePercent?: number;
}): GenerationEstimate {
  const model = getVideoModel(input.modelId);
  const allowed = getAllowedDurations(input.modelId, input.resolution);
  const clipSeconds = Math.max(...allowed);
  const shots = Math.ceil(input.durationSeconds / clipSeconds);
  const billableSeconds = shots * clipSeconds;
  const price = model.pricePerSecondUsd[input.resolution] ?? model.pricePerSecondUsd["720p"] ?? 0;
  const videoUsd = billableSeconds * price;
  const audioUsd = model.nativeAudio ? 0 : input.durationSeconds * 0.005;
  const retriesReserveUsd = (videoUsd + audioUsd) * ((input.retryReservePercent ?? 12) / 100);
  return {
    shots,
    clipSeconds,
    videoUsd: roundMoney(videoUsd),
    audioUsd: roundMoney(audioUsd),
    retriesReserveUsd: roundMoney(retriesReserveUsd),
    estimatedTotalUsd: roundMoney(videoUsd + audioUsd + retriesReserveUsd),
    approximate: true,
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export const DURATION_OPTIONS = [10, 30, 60, 180, 300, 600, 900, 1200, 1800, 2700, 3600] as const;

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes} min`;
}
