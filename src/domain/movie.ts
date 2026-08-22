import { z } from "zod";

export const ProjectStatusSchema = z.enum([
  "draft",
  "planning",
  "planned",
  "queued",
  "generating",
  "validating",
  "assembling",
  "completed",
  "paused",
  "failed",
  "cancelled",
]);

export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const JobStateSchema = z.enum([
  "planned",
  "queued",
  "generating",
  "validating",
  "retrying",
  "completed",
  "paused",
  "failed",
  "cancelled",
]);

export type JobState = z.infer<typeof JobStateSchema>;

export const DialogueSchema = z.object({
  id: z.string(),
  characterId: z.string(),
  characterName: z.string(),
  text: z.string(),
  startSeconds: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
  delivery: z.string(),
});

export const AudioContextSchema = z.object({
  cleanStart: z.boolean(),
  speakers: z.array(z.string()),
  silentCharacters: z.array(z.string()),
  dialogue: z.array(DialogueSchema),
  ambience: z.array(z.string()),
  soundEffects: z.array(z.string()),
  musicCue: z.string().nullable(),
  forbidCarryOver: z.array(z.string()),
});

export type AudioContext = z.infer<typeof AudioContextSchema>;

export const ContinuityStateSchema = z.object({
  characterStates: z.record(
    z.string(),
    z.object({
      locationId: z.string(),
      wardrobeId: z.string(),
      heldProps: z.array(z.string()),
      injuries: z.array(z.string()),
      appearanceChanges: z.array(z.string()),
      position: z.string(),
      emotionalState: z.string(),
    }),
  ),
  locationId: z.string(),
  locationState: z.object({
    timeOfDay: z.string(),
    weather: z.string(),
    lighting: z.string(),
    objectPositions: z.record(z.string(), z.string()),
  }),
  previousShotId: z.string().nullable(),
  nextShotId: z.string().nullable(),
  requiredReferences: z.array(z.string()),
  lockedValues: z.record(z.string(), z.unknown()),
});

export type ContinuityState = z.infer<typeof ContinuityStateSchema>;

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number().int().positive(),
  gender: z.string(),
  face: z.string(),
  hair: z.string(),
  height: z.string(),
  build: z.string(),
  wardrobe: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      clothing: z.array(z.string()),
      shoes: z.string(),
      accessories: z.array(z.string()),
      validFromSceneId: z.string(),
      validToSceneId: z.string().nullable(),
    }),
  ),
  voice: z.object({
    description: z.string(),
    speechPattern: z.string(),
    provider: z.string().nullable(),
    providerVoiceId: z.string().nullable(),
  }),
  personality: z.string(),
  backstory: z.string(),
  relationships: z.record(z.string(), z.string()),
  referenceAssetIds: z.array(z.string()),
  locks: z.object({
    appearance: z.boolean(),
    voice: z.boolean(),
    outfit: z.boolean(),
  }),
});

export type Character = z.infer<typeof CharacterSchema>;

export const LocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  appearance: z.string(),
  architecture: z.string(),
  furniture: z.array(z.string()),
  objectLayout: z.record(z.string(), z.string()),
  defaultLighting: z.string(),
  defaultWeather: z.string(),
  timeOfDay: z.string(),
  importantDetails: z.array(z.string()),
  referenceAssetIds: z.array(z.string()),
  designLocked: z.boolean(),
});

export type Location = z.infer<typeof LocationSchema>;

export const CameraSchema = z.object({
  shotSize: z.string(),
  angle: z.string(),
  lens: z.string(),
  movement: z.string(),
  framing: z.string(),
  fps: z.number().int().positive(),
});

export const GenerationPromptSchema = z.object({
  sceneIntent: z.string(),
  modelId: z.string(),
  prompt: z.string(),
  negativeDirectives: z.array(z.string()),
  referenceAssetIds: z.array(z.string()),
  seed: z.number().int().nullable(),
});

export const ShotSchema = z.object({
  id: z.string(),
  sceneId: z.string(),
  sequence: z.number().int().positive(),
  title: z.string(),
  durationSeconds: z.number().positive().max(10),
  action: z.string(),
  visualStyle: z.string(),
  camera: CameraSchema,
  lighting: z.string(),
  audioContext: AudioContextSchema,
  continuity: ContinuityStateSchema,
  dependencies: z.array(z.string()),
  generationPrompt: GenerationPromptSchema.nullable(),
});

export type Shot = z.infer<typeof ShotSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  actId: z.string(),
  sequenceId: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  durationSeconds: z.number().positive(),
  locationId: z.string(),
  characterIds: z.array(z.string()),
  action: z.string(),
  emotionalBeat: z.string(),
  lighting: z.string(),
  sound: z.string(),
  music: z.string().nullable(),
  timeOfDay: z.string(),
  weather: z.string(),
  continuityRequirements: z.array(z.string()),
  shots: z.array(ShotSchema),
});

export type Scene = z.infer<typeof SceneSchema>;

export const ActSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  purpose: z.string(),
  startSceneNumber: z.number().int().positive(),
  endSceneNumber: z.number().int().positive(),
});

export const MoviePlanSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  summary: z.object({
    title: z.string(),
    genre: z.string(),
    style: z.string(),
    mood: z.string(),
    durationSeconds: z.number().positive(),
    logline: z.string(),
    synopsis: z.string(),
  }),
  characters: z.array(CharacterSchema),
  locations: z.array(LocationSchema),
  acts: z.array(ActSchema),
  scenes: z.array(SceneSchema),
  createdAt: z.string(),
});

export type MoviePlan = z.infer<typeof MoviePlanSchema>;

export interface ProjectRecord {
  id: string;
  title: string;
  prompt: string;
  durationSeconds: number;
  modelId: string;
  resolution: string;
  aspectRatio: string;
  renderTier?: "draft" | "final";
  status: ProjectStatus;
  progress: number;
  maximumBudgetUsd: number;
  estimatedCostUsd: number;
  spentUsd: number;
  completedShots: number;
  totalShots: number;
  posterUrl?: string;
  updatedAt: string;
}

export interface ShotArtifact {
  id: string;
  projectId: string;
  sceneId: string;
  shotId: string;
  version: number;
  contentHash: string;
  storageKey: string;
  mimeType: string;
  durationSeconds: number;
  continuityScore: number | null;
  active: boolean;
}

/**
 * Closed models frequently reuse convenient IDs such as `scene-1`. The database
 * intentionally stores graph nodes by stable text ID, so every generated ID and
 * every internal reference is namespaced before persistence.
 */
export function scopeMoviePlanIds(input: MoviePlan): MoviePlan {
  const prefix = `${input.projectId}:`;
  const graphId = (kind: string, value: string) => value.startsWith(prefix) ? value : `${prefix}${kind}:${value}`;
  const wardrobeGraphId = (characterId: string, value: string) => value.startsWith(prefix) ? value : `${prefix}wardrobe:${characterId}:${value}`;
  const characterIds = new Map(input.characters.map((item) => [item.id, graphId("character",item.id)]));
  const locationIds = new Map(input.locations.map((item) => [item.id, graphId("location",item.id)]));
  const actIds = new Map(input.acts.map((item) => [item.id, graphId("act",item.id)]));
  const sequenceIds = new Map(input.scenes.map((item) => [item.sequenceId, graphId("sequence",item.sequenceId)]));
  const sceneIds = new Map(input.scenes.map((item) => [item.id, graphId("scene",item.id)]));
  const shotIds = new Map(input.scenes.flatMap((scene) => scene.shots.map((item) => [item.id, graphId("shot",item.id)] as const)));
  const dialogueIds = new Map(input.scenes.flatMap((scene) => scene.shots.flatMap((shot) => shot.audioContext.dialogue.map((item) => [item.id, graphId("dialogue",item.id)] as const))));
  const wardrobeIds = new Map<string, Map<string, string>>();
  for (const character of input.characters) wardrobeIds.set(character.id, new Map(character.wardrobe.map((item) => [item.id, wardrobeGraphId(character.id,item.id)])));
  const reference = (map: Map<string,string>, value: string) => map.get(value) ?? value;

  return {
    ...input,
    id: graphId("plan",input.id),
    characters: input.characters.map((character) => ({
      ...character,
      id: reference(characterIds, character.id),
      wardrobe: character.wardrobe.map((wardrobe) => ({
        ...wardrobe,
        id: wardrobeIds.get(character.id)?.get(wardrobe.id) ?? wardrobeGraphId(character.id,wardrobe.id),
        validFromSceneId: reference(sceneIds, wardrobe.validFromSceneId),
        validToSceneId: wardrobe.validToSceneId ? reference(sceneIds, wardrobe.validToSceneId) : null,
      })),
      relationships: Object.fromEntries(Object.entries(character.relationships).map(([id,value]) => [reference(characterIds,id),value])),
    })),
    locations: input.locations.map((location) => ({ ...location, id: reference(locationIds,location.id) })),
    acts: input.acts.map((act) => ({ ...act, id: reference(actIds,act.id) })),
    scenes: input.scenes.map((scene) => ({
      ...scene,
      id: reference(sceneIds,scene.id),
      actId: reference(actIds,scene.actId),
      sequenceId: reference(sequenceIds,scene.sequenceId),
      locationId: reference(locationIds,scene.locationId),
      characterIds: scene.characterIds.map((id) => reference(characterIds,id)),
      shots: scene.shots.map((shot) => ({
        ...shot,
        id: reference(shotIds,shot.id),
        sceneId: reference(sceneIds,shot.sceneId),
        dependencies: shot.dependencies.map((id) => reference(shotIds,id)),
        audioContext: {
          ...shot.audioContext,
          speakers: shot.audioContext.speakers.map((id) => reference(characterIds,id)),
          silentCharacters: shot.audioContext.silentCharacters.map((id) => reference(characterIds,id)),
          dialogue: shot.audioContext.dialogue.map((dialogue) => ({ ...dialogue, id: reference(dialogueIds,dialogue.id), characterId: reference(characterIds,dialogue.characterId) })),
        },
        continuity: {
          ...shot.continuity,
          characterStates: Object.fromEntries(Object.entries(shot.continuity.characterStates).map(([characterId,state]) => [
            reference(characterIds,characterId),
            {
              ...state,
              locationId: reference(locationIds,state.locationId),
              wardrobeId: wardrobeIds.get(characterId)?.get(state.wardrobeId) ?? wardrobeGraphId(characterId,state.wardrobeId),
            },
          ])),
          locationId: reference(locationIds,shot.continuity.locationId),
          previousShotId: shot.continuity.previousShotId ? reference(shotIds,shot.continuity.previousShotId) : null,
          nextShotId: shot.continuity.nextShotId ? reference(shotIds,shot.continuity.nextShotId) : null,
        },
      })),
    })),
  };
}
