import { describe, expect, it } from "vitest";
import { zodTextFormat } from "openai/helpers/zod";
import { buildContinuityState, validateContinuity } from "@/server/movie/continuity";
import { MoviePlanStructuredOutputSchema, scopeMoviePlanIds, type MoviePlan } from "@/domain/movie";
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
  it("namespaces every graph ID and reference per project without double-prefixing", () => {
    const projectId = "00000000-0000-0000-0000-000000000111";
    const plan: MoviePlan = {
      id: "plan-1", projectId,
      summary: { title: "Isolated", genre: "drama", style: "realistic", mood: "quiet", durationSeconds: 8, logline: "A test", synopsis: "A scoped graph." },
      characters: [character()], locations: [location()],
      acts: [{ id: "act-1", number: 1, title: "One", purpose: "Set-up", startSceneNumber: 1, endSceneNumber: 1 }],
      scenes: [scene()], createdAt: new Date(0).toISOString(),
    };
    const scoped = scopeMoviePlanIds(plan);
    const twice = scopeMoviePlanIds(scoped);
    expect(scoped.characters[0].id).toBe(`${projectId}:character:character-elias`);
    expect(scoped.scenes[0].shots[0].continuity.characterStates[scoped.characters[0].id].locationId).toBe(scoped.locations[0].id);
    expect(scoped.scenes[0].shots[0].sceneId).toBe(scoped.scenes[0].id);
    expect(twice).toEqual(scoped);
  });
  it("keeps every object closed for OpenAI strict Structured Outputs", () => {
    const format = zodTextFormat(MoviePlanStructuredOutputSchema, "movie_plan");
    const openObjects: string[] = [];
    const visit = (value: unknown, path = "$") => {
      if (!value || typeof value !== "object") return;
      const row = value as Record<string, unknown>;
      if (row.type === "object" && row.additionalProperties !== false) openObjects.push(path);
      for (const [key, child] of Object.entries(row)) visit(child, `${path}.${key}`);
    };
    visit(format.schema);
    expect(openObjects).toEqual([]);
  });
});
