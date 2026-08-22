import { describe, expect, it } from "vitest";
import { buildContinuityState, validateContinuity } from "@/server/movie/continuity";
import { character, location, scene, shot } from "./fixtures";

describe("Project Memory and continuity", () => {
  it("carries wardrobe and required references from the previous shot", () => {
    const previous = shot("shot-1");
    previous.continuity.characterStates["character-elias"].heldProps = ["silver drive"];
    const state = buildContinuityState({ scene: scene([previous]), shotId: "shot-2", previousShot: previous, nextShot: null, characters: [character()], location: location(), lockedValues: { "character-elias.face": "angular" } });
    expect(state.characterStates["character-elias"].wardrobeId).toBe("coat");
    expect(state.characterStates["character-elias"].heldProps).toEqual(["silver drive"]);
    expect(state.requiredReferences).toEqual(["ref-face","ref-street"]);
    expect(state.lockedValues).toEqual({ "character-elias.face": "angular" });
  });
  it("penalizes an unexpected wardrobe and location change", () => {
    const expected = shot().continuity;
    const actual = structuredClone(expected);
    actual.locationId = "wrong-location";
    actual.characterStates["character-elias"].wardrobeId = "blue-suit";
    const result = validateContinuity(expected, actual);
    expect(result.score).toBe(64);
    expect(result.issues.map((issue) => issue.field)).toContain("character.character-elias.wardrobeId");
  });
});
