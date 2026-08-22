import type { AudioContext, ContinuityState, MoviePlan } from "@/domain/movie";
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
      `VISUAL STYLE: ${intent.visualStyle}; natural physical motion, coherent anatomy, consistent identity and wardrobe.`,
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
        `Visual treatment: ${intent.visualStyle}. Consider micro-detail, natural expression and physical timing.`,
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
