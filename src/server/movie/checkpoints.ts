export interface CheckpointSnapshot {
  projectId: string;
  planVersion: number;
  completedShotIds: string[];
  failedShotIds: string[];
  pendingShotIds: string[];
  currentJobId: string | null;
  spentUsd: number;
  projectMemoryHash: string;
  createdAt: string;
}

export function nextCheckpoint(
  previous: CheckpointSnapshot,
  event: { type: "shot-completed" | "shot-failed" | "paused" | "resumed"; shotId?: string; spentDeltaUsd?: number; currentJobId?: string | null },
): CheckpointSnapshot {
  const completed = new Set(previous.completedShotIds);
  const failed = new Set(previous.failedShotIds);
  const pending = new Set(previous.pendingShotIds);
  if (event.shotId && event.type === "shot-completed") {
    completed.add(event.shotId);
    failed.delete(event.shotId);
    pending.delete(event.shotId);
  }
  if (event.shotId && event.type === "shot-failed") {
    failed.add(event.shotId);
    pending.delete(event.shotId);
  }
  return {
    ...previous,
    completedShotIds: [...completed],
    failedShotIds: [...failed],
    pendingShotIds: [...pending],
    currentJobId: event.currentJobId === undefined ? previous.currentJobId : event.currentJobId,
    spentUsd: previous.spentUsd + (event.spentDeltaUsd ?? 0),
    createdAt: new Date().toISOString(),
  };
}

export function resumeFromCheckpoint(snapshot: CheckpointSnapshot, allShotIds: string[]): {
  resumeShotIds: string[];
  completedShotIds: string[];
} {
  const completed = new Set(snapshot.completedShotIds);
  return {
    completedShotIds: [...completed],
    resumeShotIds: allShotIds.filter((shotId) => !completed.has(shotId)),
  };
}
