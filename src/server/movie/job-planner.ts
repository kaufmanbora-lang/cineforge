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

export function planGenerationJobs(projectId: string, scenes: Scene[], options: { fastDraft?: boolean } = {}): PlannedJob[] {
  const jobs = scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot })));
  const sceneOrder = new Map(scenes.map((scene, index) => [scene.id, index]));
  const sceneByShot = new Map(jobs.map(({ scene, shot }) => [shot.id, scene.id]));
  const shotIds = new Set(sceneByShot.keys());
  return jobs.map(({ scene, shot }) => {
    // Structured screenplay models occasionally put character, wardrobe or location
    // IDs in this field. Only shot IDs are scheduling dependencies; accepting any
    // other graph node leaves the first generation permanently in `planned`.
    // Fast Draft may skip expensive QC, but it must never break the story graph.
    // In particular, cross-scene dependencies are what make the previous final
    // frame, blocking and project state available to the next generation.
    // `previousShotId` records chronological memory, not necessarily a visual
    // dependency. The runtime normalizer puts only continuous boundaries in
    // `shot.dependencies`; treating every hard cut as dependent serializes a
    // whole movie and makes independent locations unnecessarily slow.
    const dependencies = [...new Set(shot.dependencies)]
      .filter((id) => id !== shot.id && shotIds.has(id));
    const specHash = contentHash({
      prompt: shot.generationPrompt,
      references: shot.continuity.requiredReferences,
      dependencies,
      continuity: shot.continuity,
      durationSeconds: shot.durationSeconds,
      audioContext: shot.audioContext,
      renderTier: options.fastDraft ? "draft" : "final",
    });
    return {
      projectId,
      sceneId: scene.id,
      shotId: shot.id,
      type: "generate-shot" as const,
      idempotencyKey: `generate-shot:${shot.id}:${specHash}`,
      dependencies,
      priority: 10_000 - (sceneOrder.get(scene.id) ?? 0) * 100 - shot.sequence,
      payload: { shot: { ...shot, dependencies }, specHash },
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
