import type { Character, ContinuityState, Location, Scene, Shot } from "@/domain/movie";

export interface ContinuityIssue {
  field: string;
  expected: unknown;
  actual: unknown;
  severity: "warning" | "error";
}

export function buildContinuityState(input: {
  scene: Pick<Scene, "locationId" | "timeOfDay" | "weather">;
  shotId: string;
  previousShot: Shot | null;
  nextShot: Shot | null;
  characters: Character[];
  location: Location;
  lockedValues: Record<string, unknown>;
}): ContinuityState {
  const previousCharacters = input.previousShot?.continuity.characterStates ?? {};
  const characterStates = Object.fromEntries(input.characters.map((character) => {
    const previous = previousCharacters[character.id];
    const wardrobe = character.wardrobe.find((entry) => !entry.validToSceneId) ?? character.wardrobe[0];
    return [character.id, previous ?? {
      locationId: input.scene.locationId,
      wardrobeId: wardrobe?.id ?? "wardrobe-default",
      heldProps: [],
      injuries: [],
      appearanceChanges: [],
      position: "establish on blocking pass",
      emotionalState: "scripted scene state",
    }];
  }));

  return {
    characterStates,
    locationId: input.scene.locationId,
    locationState: {
      timeOfDay: input.scene.timeOfDay,
      weather: input.scene.weather,
      lighting: input.location.defaultLighting,
      objectPositions: input.location.objectLayout,
    },
    previousShotId: input.previousShot?.id ?? null,
    nextShotId: input.nextShot?.id ?? null,
    requiredReferences: [
      ...input.characters.flatMap((character) => character.referenceAssetIds),
      ...input.location.referenceAssetIds,
    ],
    lockedValues: input.lockedValues,
  };
}

export function validateContinuity(expected: ContinuityState, actual: ContinuityState): {
  score: number;
  issues: ContinuityIssue[];
} {
  const issues: ContinuityIssue[] = [];
  compare("locationId", expected.locationId, actual.locationId, "error", issues);
  compare("timeOfDay", expected.locationState.timeOfDay, actual.locationState.timeOfDay, "warning", issues);
  compare("weather", expected.locationState.weather, actual.locationState.weather, "warning", issues);
  compare("lighting", expected.locationState.lighting, actual.locationState.lighting, "warning", issues);

  for (const [characterId, expectedState] of Object.entries(expected.characterStates)) {
    const actualState = actual.characterStates[characterId];
    if (!actualState) {
      issues.push({ field: `character.${characterId}`, expected: expectedState, actual: null, severity: "error" });
      continue;
    }
    compare(`character.${characterId}.wardrobeId`, expectedState.wardrobeId, actualState.wardrobeId, "error", issues);
    compare(`character.${characterId}.injuries`, expectedState.injuries, actualState.injuries, "error", issues);
    compare(`character.${characterId}.heldProps`, expectedState.heldProps, actualState.heldProps, "warning", issues);
  }

  const penalty = issues.reduce((sum, issue) => sum + (issue.severity === "error" ? 18 : 7), 0);
  return { score: Math.max(0, 100 - penalty), issues };
}

function compare(field: string, expected: unknown, actual: unknown, severity: ContinuityIssue["severity"], issues: ContinuityIssue[]) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) issues.push({ field, expected, actual, severity });
}
