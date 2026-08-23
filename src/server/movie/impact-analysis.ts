import type { Scene } from "@/domain/movie";

export interface TimelineIndexEntry {
  sceneId: string;
  sceneNumber: number;
  shotId: string;
  shotSequence: number;
  startSeconds: number;
  endSeconds: number;
  dialogueIds: string[];
}

export interface ImpactAnalysis {
  intent: "dialogue" | "visual" | "audio" | "mixed";
  affected: Array<{ sceneId: string; shotId: string; dialogueIds: string[]; tracks: string[] }>;
  unaffected: { before: string[]; after: string[] };
  requiresVideoRegeneration: boolean;
  reason: string;
}

const VISUAL_TERMS = /rain|дожд|цвет|black|white|чёрн|бел|remove person|убер.*человек|убер.*машин|lighting|свет|appearance|внешност|одежд|куртк|пальто|рубаш|плать|wardrobe|outfit|лиц|волос|погод|локац|фон/i;
const DIALOGUE_TERMS = /слово|реплик|говор|dialogue|says|phrase|фраз|tone|груб|спокой/i;

export function analyzeEdit(command: string, timeline: TimelineIndexEntry[], selected?: { sceneId?: string; shotId?: string }): ImpactAnalysis {
  if (!timeline.length) throw new Error("Timeline is empty.");
  const timestamp = parseTimestamp(command);
  const sceneNumber = parseSceneNumber(command);
  const explicitTarget = selected?.shotId
    ? timeline.find((entry) => entry.shotId === selected.shotId)
    : selected?.sceneId
      ? timeline.find((entry) => entry.sceneId === selected.sceneId)
      : undefined;
  const target = timestamp !== null
    ? timeline.find((entry) => timestamp >= entry.startSeconds && timestamp < entry.endSeconds)
    : sceneNumber !== null
      ? timeline.find((entry) => entry.sceneNumber === sceneNumber)
      : explicitTarget ?? timeline[0];
  if (!target) throw new Error("The requested edit does not match a scene or timestamp.");

  const dialogue = DIALOGUE_TERMS.test(command);
  const visual = VISUAL_TERMS.test(command);
  const intent: ImpactAnalysis["intent"] = dialogue && visual ? "mixed" : visual ? "visual" : dialogue ? "dialogue" : "audio";
  const onlyDialogue = dialogue && !visual;
  const targetIndex = timeline.indexOf(target);
  return {
    intent,
    affected: [{
      sceneId: target.sceneId,
      shotId: target.shotId,
      dialogueIds: onlyDialogue ? target.dialogueIds : [],
      tracks: onlyDialogue ? ["dialogue", "subtitles"] : visual ? ["video", "ambience", "sfx"] : ["audio"],
    }],
    unaffected: {
      before: timeline.slice(0, targetIndex).map((entry) => entry.shotId),
      after: timeline.slice(targetIndex + 1).map((entry) => entry.shotId),
    },
    requiresVideoRegeneration: visual,
    reason: onlyDialogue
      ? "The request changes dialogue only; preserve the original video frames and rebuild dialogue/subtitle tracks."
      : visual
        ? "The request changes visible pixels; regenerate only the matched shot and replace its timeline clip."
        : "The request affects only the selected shot audio context.",
  };
}

function parseTimestamp(command: string): number | null {
  const match = command.match(/(?:at|на|@)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] ? Number(match[3]) : null;
  return third === null ? first * 60 + second : first * 3600 + second * 60 + third;
}

function parseSceneNumber(command: string): number | null {
  const match = command.match(/(?:scene|сцен[аеуы]?)\s*#?\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function buildTimelineIndex(scenes: Scene[]): TimelineIndexEntry[] {
  let cursor = 0;
  return scenes.flatMap((scene) => scene.shots.map((shot) => {
    const entry = {
      sceneId: scene.id,
      sceneNumber: scene.number,
      shotId: shot.id,
      shotSequence: shot.sequence,
      startSeconds: cursor,
      endSeconds: cursor + shot.durationSeconds,
      dialogueIds: shot.audioContext.dialogue.map((dialogue) => dialogue.id),
    };
    cursor = entry.endSeconds;
    return entry;
  }));
}
