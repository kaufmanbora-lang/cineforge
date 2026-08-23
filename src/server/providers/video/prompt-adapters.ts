import type { AudioContext, ContinuityState, MoviePlan, Shot } from "@/domain/movie";
import type { PromptAdapter } from "./types";

export interface ShotIntent {
  durationSeconds: number;
  subject: string;
  environment: string;
  action: string;
  camera: { shotSize: string; angle: string; lens: string; movement: string; framing: string };
  lighting: string;
  weather: string;
  visualStyle: string;
  characterDetails: string[];
  continuity: ContinuityState;
  audio: AudioContext;
}

export function realismProductionProfile(styleOrPrompt: string): string {
  const negatedAnimation = /(?:not|no|without|не|без)\s+(?:a\s+)?(?:animation|animated|anime|cartoon|illustration|cgi|мульт\w*|аним\w*|рисован\w*)/i.test(styleOrPrompt);
  const explicitAnimation = !negatedAnimation && /(?:animation|animated|anime|cartoon|illustration|stop[ -]?motion|3d render|мульт\w*|аним\w*|рисован\w*|стоп[ -]?моуш)/i.test(styleOrPrompt);
  if (explicitAnimation) return "Honor the explicitly requested animated or illustrated production style while preserving coherent physics and continuity.";
  return "PHOTOREALISTIC LIVE-ACTION DEFAULT: footage must look captured by a real cinema camera in the physical world, with natural skin texture, materials, lens behavior, exposure, motion blur, anatomy and weight. Not animation, not anime, not cartoon, not illustration, not a 3D render, not game-engine footage, no plastic CGI skin.";
}

export class VeoPromptAdapter implements PromptAdapter<ShotIntent> {
  readonly family = "veo" as const;

  build(intent: ShotIntent): { prompt: string; negativeDirectives: string[] } {
    const dialogue = intent.audio.dialogue
      .map((line) => `${line.characterName} (${line.delivery}) says exactly: "${line.text}"`)
      .join("\n");
    const prompt = [
      `Create one ${intent.durationSeconds}-second cinematic shot.`,
      `SUBJECT: ${intent.subject}`,
      `ENVIRONMENT: ${intent.environment}`,
      `ACTION: ${intent.action}`,
      `CHARACTER CONTINUITY: ${intent.characterDetails.join("; ")}`,
      `CAMERA: ${intent.camera.shotSize}, ${intent.camera.angle}, ${intent.camera.lens}; ${intent.camera.movement}; framing ${intent.camera.framing}.`,
      `LIGHTING / WEATHER: ${intent.lighting}; ${intent.weather}.`,
      `VISUAL STYLE: ${intent.visualStyle}. ${realismProductionProfile(intent.visualStyle)} Natural physical motion, coherent anatomy, consistent identity and wardrobe. Enforce ordinary real-world geometry, inertia, gravity, collisions and occlusion: solid people, vehicles, walls, doors and props never intersect, pass through each other, teleport or change scale.`,
      `AUDIO CONTEXT: clean audio start=${intent.audio.cleanStart}. Speakers: ${intent.audio.speakers.join(", ") || "none"}.`,
      dialogue || "No dialogue.",
      `Ambience: ${intent.audio.ambience.join(", ") || "none"}. Sound effects: ${intent.audio.soundEffects.join(", ") || "none"}. Music: ${intent.audio.musicCue ?? "none"}.`,
      `Do not carry over: ${intent.audio.forbidCarryOver.join(", ") || "any prior speech or music"}.`,
      `MATCH STATE: location ${intent.continuity.locationId}; previous shot ${intent.continuity.previousShotId ?? "none"}; preserve all locked values and supplied references.`,
    ].join("\n");
    return {
      prompt,
      negativeDirectives: [
        "identity drift",
        "wardrobe changes not in the screenplay",
        "extra dialogue",
        "audio carry-over",
        "unexpected text overlays",
        "cartoon, anime, illustration or CGI look unless explicitly requested",
      ],
    };
  }

  buildEdit(originalPrompt: string, editInstruction: string): string {
    return `${originalPrompt}\nREVISION: ${editInstruction}. Change only the requested detail; preserve identity, wardrobe, blocking, camera, timing and audio unless explicitly affected.`;
  }
}

export class OmniPromptAdapter implements PromptAdapter<ShotIntent> {
  readonly family = "omni" as const;

  build(intent: ShotIntent): { prompt: string; negativeDirectives: string[] } {
    const dialogue = intent.audio.dialogue
      .map((line) => `${line.characterName} says exactly, ${line.delivery}: "${line.text}"`)
      .join(" ");
    const refs = intent.continuity.requiredReferences.map((_, index) => `<IMAGE_REF_${index}>`).join(" ");
    const negatives = ["No extra dialogue", "No audio carry-over", "No unplanned wardrobe changes", "No text overlays"];
    return {
      prompt: [
        `[0-${intent.durationSeconds}s] In a single continuous shot, no scene cuts.`,
        `${refs} ${intent.subject}. ${intent.action}`,
        `${intent.environment}. ${intent.weather}. ${intent.lighting}.`,
        `Camera: ${intent.camera.shotSize}, ${intent.camera.angle}, ${intent.camera.lens}, ${intent.camera.movement}; ${intent.camera.framing}.`,
        `Keep character identity, wardrobe, prop positions and location design exactly consistent with the reference images.`,
        dialogue || "No dialogue.",
        `Sound design: ${intent.audio.ambience.join(", ") || "clean ambience"}; ${intent.audio.soundEffects.join(", ") || "no extra effects"}; music ${intent.audio.musicCue ?? "none"}.`,
        `Clean audio start. ${negatives.join(". ")}.`,
        `Visual treatment: ${intent.visualStyle}. ${realismProductionProfile(intent.visualStyle)} Consider micro-detail, natural expression and physical timing. Enforce real-world geometry, gravity, inertia, collision and occlusion. Solid bodies never pass through walls, vehicles, furniture or each other; no teleportation, impossible pose, sudden scale change or discontinuous motion.`,
      ].join(" "),
      negativeDirectives: negatives,
    };
  }

  buildEdit(_originalPrompt: string, editInstruction: string): string {
    return `${editInstruction}. Keep everything else the same.`;
  }
}

export function promptAdapterFor(modelId: string): PromptAdapter<ShotIntent> {
  return modelId.startsWith("gemini-omni") ? new OmniPromptAdapter() : new VeoPromptAdapter();
}

export function adaptMoviePlanPrompts(plan: MoviePlan, modelId: string): MoviePlan {
  plan = normalizeMoviePlanRuntime(plan, modelId);
  const adapter = promptAdapterFor(modelId);
  return {
    ...plan,
    scenes: plan.scenes.map((scene) => {
      const location = plan.locations.find((item) => item.id === scene.locationId);
      const characters = plan.characters.filter((character) => scene.characterIds.includes(character.id));
      return {
        ...scene,
        shots: scene.shots.map((shot) => {
          const intent: ShotIntent = {
            durationSeconds: shot.durationSeconds,
            subject: characters.length ? characters.map((character) => character.name).join(" and ") : "the scripted subject",
            environment: location ? `${location.name}: ${location.appearance}; ${location.architecture}; important details ${location.importantDetails.join(", ")}` : scene.action,
            action: shot.action,
            camera: shot.camera,
            lighting: shot.lighting || scene.lighting,
            weather: scene.weather,
            visualStyle: shot.visualStyle || plan.summary.style,
            characterDetails: characters.map((character) => {
              const wardrobeId = shot.continuity.characterStates[character.id]?.wardrobeId;
              const wardrobe = character.wardrobe.find((item) => item.id === wardrobeId) ?? character.wardrobe[0];
              return `${character.name}: ${character.face}; ${character.hair}; ${character.build}; wardrobe ${wardrobe?.clothing.join(", ") ?? "scripted"}; voice ${character.voice.description}`;
            }),
            continuity: shot.continuity,
            audio: shot.audioContext,
          };
          const adapted = adapter.build(intent);
          return {
            ...shot,
            generationPrompt: {
              sceneIntent: shot.generationPrompt?.sceneIntent ?? shot.action,
              modelId,
              prompt: adapted.prompt,
              negativeDirectives: adapted.negativeDirectives,
              referenceAssetIds: shot.continuity.requiredReferences,
              seed: shot.generationPrompt?.seed ?? null,
            },
          };
        }),
      };
    }),
  };
}

/**
 * Turns an approximate screenplay timeline into an exact production timeline.
 * Omni currently has no durationSeconds request field, so short five-second
 * beats are considerably more reliable than asking one interaction for a long
 * clip. Every beat is newly generated; no frame repetition or slow-down is used.
 */
export function normalizeMoviePlanRuntime(plan: MoviePlan, modelId: string): MoviePlan {
  const maxBeatSeconds = modelId.startsWith("gemini-omni") ? 5 : 8;
  let scenes = plan.scenes.map((scene) => ({
    ...scene,
    shots: scene.shots.flatMap((shot) => splitShotIntoBeats(shot, maxBeatSeconds)),
  }));
  const target = plan.summary.durationSeconds;
  let total = scenes.flatMap((scene) => scene.shots).reduce((sum, shot) => sum + shot.durationSeconds, 0);

  // Structured models can be a few seconds short. Fill the missing runtime with
  // newly described chronological action, never with duplicated media.
  if (total < target && scenes.length) {
    const sceneIndex = scenes.length - 1;
    const shots = [...scenes[sceneIndex].shots];
    const template = shots.at(-1);
    if (template) {
      let remaining = target - total;
      let part = 1;
      while (remaining > 0.001) {
        const durationSeconds = Math.min(maxBeatSeconds, remaining);
        shots.push({
          ...template,
          id: `${template.id}-runtime-${part}`,
          sequence: template.sequence + part,
          title: `${template.title} — продолжение ${part}`,
          durationSeconds,
          action: `${template.action}. Следующий содержательный момент: действие естественно продолжается вперёд, без повтора уже показанных кадров и без паузы.`,
          audioContext: { ...template.audioContext, speakers: [], dialogue: [], cleanStart: true },
          dependencies: [],
        });
        remaining -= durationSeconds;
        part += 1;
      }
      scenes[sceneIndex] = { ...scenes[sceneIndex], shots };
      total = target;
    }
  }

  // If the draft is long, trim only ungenerated tail beats to the requested
  // runtime. Provider output itself is never slowed down or duplicated.
  if (total > target) {
    let cursor = 0;
    scenes = scenes.map((scene) => {
      const shots: Shot[] = [];
      for (const shot of scene.shots) {
        const remaining = target - cursor;
        if (remaining <= 0) break;
        const durationSeconds = Math.min(shot.durationSeconds, remaining);
        shots.push({ ...shot, durationSeconds });
        cursor += durationSeconds;
      }
      return { ...scene, shots };
    }).filter((scene) => scene.shots.length > 0);
  }

  // Canonical chronological chain: this is the source of truth for scheduling,
  // previous-frame references and Project Memory across scene boundaries.
  const timeline = scenes.flatMap((scene) => scene.shots);
  const validIds = new Set(timeline.map((shot) => shot.id));
  let timelineIndex = 0;
  scenes = scenes.map((scene) => {
    const shots = scene.shots.map((shot) => {
      const previous = timeline[timelineIndex - 1];
      const next = timeline[timelineIndex + 1];
      timelineIndex += 1;
      return {
        ...shot,
        sequence: timelineIndex,
        dependencies: [...new Set([
          ...shot.dependencies.filter((id) => validIds.has(id) && id !== shot.id),
          ...(previous ? [previous.id] : []),
        ])],
        continuity: { ...shot.continuity, previousShotId: previous?.id ?? null, nextShotId: next?.id ?? null },
      };
    });
    return { ...scene, shots, durationSeconds: shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) };
  });

  return { ...plan, summary: { ...plan.summary, durationSeconds: target }, scenes };
}

function splitShotIntoBeats(shot: Shot, maxBeatSeconds: number): Shot[] {
  if (shot.durationSeconds <= maxBeatSeconds) return [shot];
  const beats: Shot[] = [];
  let offset = 0;
  while (offset < shot.durationSeconds - 0.001) {
    const durationSeconds = Math.min(maxBeatSeconds, shot.durationSeconds - offset);
    const index = beats.length + 1;
    const dialogue = shot.audioContext.dialogue
      .filter((line) => line.startSeconds >= offset && line.startSeconds < offset + durationSeconds)
      .map((line) => ({ ...line, startSeconds: line.startSeconds - offset, durationSeconds: Math.min(line.durationSeconds, durationSeconds - (line.startSeconds - offset)) }));
    beats.push({
      ...shot,
      id: `${shot.id}-beat-${index}`,
      sequence: shot.sequence + index - 1,
      title: `${shot.title} — часть ${index}`,
      durationSeconds,
      action: `${shot.action}. Хронологическая часть ${index}: продолжить движение и состояние с предыдущей части без скачка.`,
      audioContext: { ...shot.audioContext, speakers: dialogue.map((line) => line.characterId), dialogue, cleanStart: true },
      dependencies: [],
    });
    offset += durationSeconds;
  }
  return beats;
}
