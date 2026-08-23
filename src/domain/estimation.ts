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

export interface GenerationEtaJob {
  type: string;
  state: string;
  created_at?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

const ACTIVE_PRODUCTION_STATES = new Set(["planning", "queued", "generating", "validating", "assembling"]);
const ACTIVE_JOB_STATES = new Set(["generating", "validating", "retrying"]);

/**
 * Estimates wall-clock time from this project's own completed shot timings.
 * Until a project has useful samples, the selected model supplies a conservative baseline.
 */
export function estimateRemainingGenerationSeconds(input: {
  jobs: GenerationEtaJob[];
  completedShots: number;
  totalShots: number;
  status: string;
  modelId: string;
  nowMs?: number;
}): number | null {
  if (input.status === "completed") return 0;
  if (!ACTIVE_PRODUCTION_STATES.has(input.status)) return null;

  const remainingShots = Math.max(0, input.totalShots - input.completedShots);
  const nowMs = input.nowMs ?? Date.now();
  const shotJobs = input.jobs.filter((job) => job.type === "generate-shot");
  const completedDurations = shotJobs
    .filter((job) => job.state === "completed")
    .map((job) => durationBetween(job.started_at ?? job.created_at, job.completed_at ?? job.updated_at))
    .filter((seconds): seconds is number => seconds !== null && seconds >= 5 && seconds <= 1_800)
    .slice(0, 8)
    .sort((a, b) => a - b);
  const baselineSeconds = completedDurations.length
    ? median(completedDurations)
    : defaultShotSeconds(input.modelId);

  const activeJobs = shotJobs.filter((job) => ACTIVE_JOB_STATES.has(job.state) && Boolean(job.started_at));
  const activeRemainingSeconds = activeJobs.reduce((sum, job) => {
    const startedMs = parseTimestamp(job.started_at);
    if (startedMs === null) return sum + baselineSeconds;
    const elapsedSeconds = Math.max(0, (nowMs - startedMs) / 1_000);
    // When a provider call exceeds the observed norm, the estimate expands instead of falsely reaching zero.
    const predictedTotalSeconds = Math.max(baselineSeconds, elapsedSeconds * 1.2);
    return sum + Math.max(5, predictedTotalSeconds - elapsedSeconds);
  }, 0);

  const waitingShots = Math.max(0, remainingShots - activeJobs.length);
  const planningBuffer = input.status === "planning" ? 30 : 0;
  const assemblyBuffer = remainingShots === 0 || input.status === "assembling" ? 25 : 20;
  return Math.ceil(planningBuffer + activeRemainingSeconds + waitingShots * baselineSeconds + assemblyBuffer);
}

export function formatRemainingGenerationTime(seconds: number): string {
  if (seconds <= 0) return "готово";
  if (seconds < 60) return "меньше 1 мин";
  return `около ${Math.ceil(seconds / 60)} мин`;
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

function durationBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  const startMs = parseTimestamp(start);
  const endMs = parseTimestamp(end);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return (endMs - startMs) / 1_000;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function median(values: number[]): number {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function defaultShotSeconds(modelId: string): number {
  if (modelId.includes("omni")) return 75;
  if (modelId.includes("fast") || modelId.includes("lite")) return 120;
  return 180;
}

export const DURATION_OPTIONS = [10, 30, 60, 180, 300, 600, 900, 1200, 1800, 2700, 3600] as const;

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds} сек`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes} мин`;
}
