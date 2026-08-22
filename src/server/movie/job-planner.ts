import type { Scene } from "@/domain/movie";
import { contentHash } from "./content-hash";

export interface PlannedJob {
  projectId: string;
  sceneId: string;
  shotId: string;
  type: "generate-shot";
  idempotencyKey: string;
  dependencies: string[];
  priority: number;
  payload: Record<string, unknown>;
}

export function planGenerationJobs(projectId: string, scenes: Scene[]): PlannedJob[] {
  const jobs = scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot })));
  const sceneOrder = new Map(scenes.map((scene, index) => [scene.id, index]));
  return jobs.map(({ scene, shot }) => {
    const specHash = contentHash({
      prompt: shot.generationPrompt,
      references: shot.continuity.requiredReferences,
      durationSeconds: shot.durationSeconds,
      audioContext: shot.audioContext,
    });
    return {
      projectId,
      sceneId: scene.id,
      shotId: shot.id,
      type: "generate-shot" as const,
      idempotencyKey: `generate-shot:${shot.id}:${specHash}`,
      dependencies: shot.dependencies,
      priority: 10_000 - (sceneOrder.get(scene.id) ?? 0) * 100 - shot.sequence,
      payload: { shot, specHash },
    };
  });
}

export function readyJobs(jobs: PlannedJob[], completedShotIds: Set<string>, runningShotIds: Set<string>, limit: number): PlannedJob[] {
  return jobs
    .filter((job) => !completedShotIds.has(job.shotId) && !runningShotIds.has(job.shotId))
    .filter((job) => job.dependencies.every((shotId) => completedShotIds.has(shotId)))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}
