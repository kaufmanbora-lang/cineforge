import type { AudioContext, ContinuityState, MoviePlan, Scene, Shot } from "@/domain/movie";
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
  previousContinuity: ContinuityState | null;
  continuousBoundary: boolean;
  audio: AudioContext;
}

export function physicalTransitionContract(input: {
  action: string;
  previous: ContinuityState | null;
  current: ContinuityState;
  continuousBoundary: boolean;
}): string {
  if (!input.previous || !input.continuousBoundary) {
    return [
      "PHYSICAL TRANSITION: this is an establishing shot or an intentional hard cut.",
      `TARGET WORLD STATE: ${JSON.stringify(worldStateSummary(input.current))}.`,
      "Do not invent motion before the visible shot begins. Establish every subject and solid boundary clearly before movement.",
    ].join("\n");
  }
  const previousObjects = input.previous.locationState.objectPositions;
  const currentObjects = input.current.locationState.objectPositions;
  const persistentObjects = Object.fromEntries(Object.entries(previousObjects).map(([id, position]) => [id, currentObjects[id] ?? position]));
  const changedCharacters = Object.entries(input.current.characterStates).flatMap(([id, state]) => {
    const before = input.previous?.characterStates[id];
    if (!before || before.position === state.position) return [];
    return [{ id, from: before.position, to: state.position }];
  });
  const changedObjects = Object.entries(currentObjects).flatMap(([id, position]) => {
    const before = previousObjects[id];
    if (before === undefined || before === position) return [];
    return [{ id, from: before, to: position }];
  });
  return [
    "PHYSICAL TRANSITION CONTRACT — CONTINUOUS BOUNDARY, NO RESET:",
    `START STATE (exact previous endpoint): ${JSON.stringify(worldStateSummary(input.previous))}.`,
    `ALLOWED STORY ACTION: ${input.action}.`,
    `DECLARED CHARACTER PATHS: ${JSON.stringify(changedCharacters)}.`,
    `DECLARED OBJECT PATHS: ${JSON.stringify(changedObjects)}.`,
    `PERSISTENT OBJECTS: ${JSON.stringify(persistentObjects)}.`,
    `TARGET END STATE: ${JSON.stringify(worldStateSummary(input.current))}.`,
    "Begin on the exact start state. Reach the target only through visible, continuous and physically reachable motion during this shot. If the available duration is insufficient, show less progress instead of teleporting.",
    "Any person or object not listed in a declared path is stationary in world space. Camera movement never changes world-space position. Solid boundaries remain closed unless the action visibly opens them; a body crosses a doorway only after the opening is clear and along one continuous path.",
  ].join("\n");
}

function worldStateSummary(continuity: ContinuityState) {
  return {
    locationId: continuity.locationId,
    timeOfDay: continuity.locationState.timeOfDay,
    weather: continuity.locationState.weather,
    lighting: continuity.locationState.lighting,
    characters: Object.fromEntries(Object.entries(continuity.characterStates).map(([id, state]) => [id, {
      position: state.position,
      wardrobeId: state.wardrobeId,
      heldProps: state.heldProps,
    }])),
    objects: continuity.locationState.objectPositions,
  };
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
      physicalTransitionContract({ action: intent.action, previous: intent.previousContinuity, current: intent.continuity, continuousBoundary: intent.continuousBoundary }),
      `CHARACTER CONTINUITY: ${intent.characterDetails.join("; ")}`,
      `CAMERA: ${intent.camera.shotSize}, ${intent.camera.angle}, ${intent.camera.lens}; ${intent.camera.movement}; framing ${intent.camera.framing}.`,
      `LIGHTING / WEATHER: ${intent.lighting}; ${intent.weather}.`,
      `VISUAL STYLE: ${intent.visualStyle}. ${realismProductionProfile(intent.visualStyle)} Natural physical motion, coherent anatomy, consistent identity and wardrobe. Enforce ordinary real-world geometry, inertia, gravity, collisions and occlusion: solid people, vehicles, walls, doors and props never intersect, pass through each other, teleport or change scale.`,
      `SPATIAL BLOCKING: ${JSON.stringify(Object.fromEntries(Object.entries(intent.continuity.characterStates).map(([id, state]) => [id, state.position])))}. Objects: ${JSON.stringify(intent.continuity.locationState.objectPositions)}. Preserve inside/outside side of every wall and doorway until a continuous visible threshold crossing occurs. Door panels and handles remain correctly hinged and oriented. Every position change follows a visible reachable path.`,
      "OBJECT / VEHICLE PERSISTENCE: every visible or recorded vehicle and prop remains in the next shot until a continuous departure or removal is shown. Preserve vehicle count, order, color, lane, curb offset, heading, wheel orientation and stopped/moving state. Continue motion from the exact prior endpoint at a plausible speed; never pop, vanish or jump.",
      "CAMERA CONTINUITY: preserve the 180-degree action axis and screen direction for continuous action. Match the supplied final-frame composition before motivated camera movement; no unplanned reverse angle or spatial reset.",
      "EYELINES: characters look at each other, the relevant prop or their direction of travel; never into the camera unless the screenplay explicitly asks for direct address.",
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
        "looking into the camera",
        "impossible side change across a wall or doorway",
        "disappearing or teleporting vehicles and props",
        "unmotivated 180-degree axis flip",
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
        `Spatial blocking: ${JSON.stringify(Object.fromEntries(Object.entries(intent.continuity.characterStates).map(([id, state]) => [id, state.position])))}. Object layout: ${JSON.stringify(intent.continuity.locationState.objectPositions)}. Preserve the inside/outside side of every doorway and wall until the person visibly crosses the threshold along a continuous reachable path. Door panels and handles stay correctly hinged and oriented.`,
        physicalTransitionContract({ action: intent.action, previous: intent.previousContinuity, current: intent.continuity, continuousBoundary: intent.continuousBoundary }),
        "Every visible vehicle and prop persists until its continuous departure or removal is shown. Preserve vehicle count, convoy order, model, color, lane, curb offset, heading, wheel orientation and stopped/moving state. Continue from the exact prior endpoint at a plausible speed; nothing pops, vanishes or jumps.",
        "For continuous action preserve the 180-degree action axis, screen direction and supplied final-frame composition before any motivated camera movement. No unplanned reverse angle, orbit or spatial reset.",
        "Natural eyelines only: look at scene partners, relevant props or travel direction, never into or acknowledge the camera unless direct address is explicitly scripted.",
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
  const shotById = new Map(plan.scenes.flatMap((scene) => scene.shots.map((shot) => [shot.id, shot] as const)));
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
            previousContinuity: shot.continuity.previousShotId ? shotById.get(shot.continuity.previousShotId)?.continuity ?? null : null,
            continuousBoundary: Boolean(shot.continuity.previousShotId && shot.dependencies.includes(shot.continuity.previousShotId)),
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
 * Omni currently has no durationSeconds request field, but its documented
 * output range reaches ten seconds. Exact prompt timecodes let common 10/30/60s
 * projects use half as many paid interactions. Every beat is newly generated;
 * no frame repetition or slow-down is used.
 */
export function normalizeMoviePlanRuntime(plan: MoviePlan, modelId: string): MoviePlan {
  const maxBeatSeconds = modelId.startsWith("gemini-omni") ? 10 : 8;
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

  // The timeline always keeps chronological memory, but only visually
  // continuous boundaries are hard scheduling dependencies. A real cut to a
  // different location/time can render in parallel without losing story state.
  const timeline = scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot })));
  const validIds = new Set(timeline.map(({ shot }) => shot.id));
  let timelineIndex = 0;
  let normalizedPrevious: Shot | null = null;
  scenes = scenes.map((scene) => {
    const shots = scene.shots.map((shot) => {
      const previous = timeline[timelineIndex - 1];
      const next = timeline[timelineIndex + 1];
      const continuousBoundary = previous ? visuallyContinuousBoundary(previous.scene, scene) : false;
      timelineIndex += 1;
      const previousContinuity = continuousBoundary ? normalizedPrevious?.continuity ?? null : null;
      const continuity = previousContinuity
        ? carryPhysicalWorldForward(previousContinuity, shot.continuity, `${scene.action} ${shot.action} ${scene.continuityRequirements.join(" ")}`)
        : shot.continuity;
      const normalized = {
        ...shot,
        sequence: timelineIndex,
        dependencies: [...new Set([
          ...shot.dependencies.filter((id) => validIds.has(id) && id !== shot.id && (id !== previous?.shot.id || continuousBoundary)),
          ...(previous && continuousBoundary ? [previous.shot.id] : []),
        ])],
        continuity: { ...continuity, previousShotId: previous?.shot.id ?? null, nextShotId: next?.shot.id ?? null },
      };
      normalizedPrevious = normalized;
      return normalized;
    });
    return { ...scene, shots, durationSeconds: shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) };
  });

  return { ...plan, summary: { ...plan.summary, durationSeconds: target }, scenes };
}

export function carryPhysicalWorldForward(previous: ContinuityState, current: ContinuityState, scriptedAction: string): ContinuityState {
  const allowsWardrobeChange = /change(?:s|d)? clothes|wardrobe change|dress(?:es|ed)?|переод|смен(?:а|ил|ила|или) одеж/i.test(scriptedAction);
  const allowsPropChange = /pick(?:s|ed)? up|put(?:s)? down|drop(?:s|ped)?|take(?:s|n)?|give(?:s|n)?|бер[её]т|взял|клад[её]т|роняет|переда[её]т/i.test(scriptedAction);
  const allowsInjuryChange = /injur|wound|hurt|лечен|ранен|травм/i.test(scriptedAction);
  const allowsObjectMovement = /move|drive|roll|walk|run|turn|stop|park|arriv|depart|enter|leave|open|close|движ|едет|поех|останав|парку|поворач|въезж|выезж|входит|выходит|откры|закры/i.test(scriptedAction);
  const characterStates = Object.fromEntries(Object.entries(current.characterStates).map(([id, state]) => {
    const before = previous.characterStates[id];
    if (!before) return [id, state];
    return [id, {
      ...state,
      locationId: previous.locationId,
      wardrobeId: allowsWardrobeChange ? state.wardrobeId : before.wardrobeId,
      heldProps: allowsPropChange ? state.heldProps : before.heldProps,
      injuries: allowsInjuryChange ? state.injuries : before.injuries,
      appearanceChanges: allowsWardrobeChange || allowsInjuryChange ? state.appearanceChanges : before.appearanceChanges,
    }];
  }));
  return {
    ...current,
    locationId: previous.locationId,
    characterStates,
    locationState: {
      timeOfDay: previous.locationState.timeOfDay,
      weather: previous.locationState.weather,
      lighting: previous.locationState.lighting,
      objectPositions: {
        ...current.locationState.objectPositions,
        ...Object.fromEntries(Object.entries(previous.locationState.objectPositions).map(([id, position]) => [
          id,
          allowsObjectMovement ? current.locationState.objectPositions[id] ?? position : position,
        ])),
      },
    },
    requiredReferences: [...new Set([...previous.requiredReferences, ...current.requiredReferences])],
    lockedValues: { ...previous.lockedValues, ...current.lockedValues },
  };
}

function visuallyContinuousBoundary(previous: Scene, current: Scene): boolean {
  if (previous.id === current.id) return true;
  // The same physical location at the same story moment remains continuous
  // even when no actor appears in both shots: parked cars, doors, furniture and
  // background objects still must not jump or disappear.
  if (previous.locationId === current.locationId
    && previous.timeOfDay === current.timeOfDay
    && previous.weather === current.weather) return true;
  // A model occasionally invents a different place/time for the next scene.
  // Treat adjacency as continuous unless the screenplay explicitly describes
  // the journey, elapsed time or editorial cut that makes the change possible.
  const transition = `${current.title} ${current.action} ${current.continuityRequirements.join(" ")}`;
  const explicitCut = /hard cut|cut to|time jump|montage transition|later that|next (?:day|morning|night)|meanwhile|after (?:the )?journey|arrives? at|travels? to|смена локации|монтажный переход|склейка на|тем временем|через (?:несколько|час|минут|дн)|на следующий день|позже|после поездки|прибыва|приезжа|подъезжа|перемещается в/i.test(transition);
  return !explicitCut;
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
