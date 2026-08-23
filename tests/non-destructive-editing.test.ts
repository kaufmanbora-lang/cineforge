import { describe, expect, it } from "vitest";
import { analyzeEdit, buildTimelineIndex } from "@/server/movie/impact-analysis";
import { scene as fixtureScene, shot as fixtureShot } from "./fixtures";

const timeline = [
  { sceneId: "scene-1", sceneNumber: 1, shotId: "shot-1", shotSequence: 1, startSeconds: 0, endSeconds: 500, dialogueIds: ["d1"] },
  { sceneId: "scene-2", sceneNumber: 2, shotId: "shot-2", shotSequence: 1, startSeconds: 500, endSeconds: 530, dialogueIds: ["d2"] },
  { sceneId: "scene-3", sceneNumber: 3, shotId: "shot-3", shotSequence: 1, startSeconds: 530, endSeconds: 600, dialogueIds: ["d3"] },
];

describe("non-destructive editing", () => {
  it("changes only dialogue and subtitles for a line edit", () => {
    const result = analyzeEdit("На 8:43 замени слово машина на автомобиль в реплике", timeline);
    expect(result.affected).toEqual([{ sceneId: "scene-2", shotId: "shot-2", dialogueIds: ["d2"], tracks: ["dialogue","subtitles"] }]);
    expect(result.requiresVideoRegeneration).toBe(false);
    expect(result.unaffected).toEqual({ before: ["shot-1"], after: ["shot-3"] });
  });
  it("regenerates only a targeted visual shot", () => {
    const result = analyzeEdit("Сделай дождь сильнее в сцене 2", timeline);
    expect(result.requiresVideoRegeneration).toBe(true);
    expect(result.affected[0].shotId).toBe("shot-2");
  });
  it("uses the editor selection when the command has no timestamp", () => {
    const result = analyzeEdit("Поменяй пальто на серое, остальное не трогай", timeline, { shotId: "shot-3" });
    expect(result.requiresVideoRegeneration).toBe(true);
    expect(result.affected[0].shotId).toBe("shot-3");
    expect(result.unaffected.before).toEqual(["shot-1", "shot-2"]);
  });
  it("targets the exact dialogue line inside a shot", () => {
    const base = fixtureShot("shot-detail");
    const detailedShot = { ...base, durationSeconds: 10, audioContext: { ...base.audioContext, speakers: ["character-elias"], dialogue: [
      { id: "first-line", characterId: "character-elias", characterName: "A", text: "First", startSeconds: 1, durationSeconds: 2, delivery: "calm" },
      { id: "second-line", characterId: "character-elias", characterName: "A", text: "Second", startSeconds: 6, durationSeconds: 2, delivery: "calm" },
    ] } };
    const detailed = [{ ...fixtureScene([detailedShot]), id: "scene-detail", durationSeconds: 10, shots: [{ ...detailedShot, sceneId: "scene-detail" }] }];
    const result = analyzeEdit("На 0:07 измени реплику", buildTimelineIndex(detailed));
    expect(result.affected[0].dialogueIds).toEqual(["second-line"]);
    expect(result.requiresVideoRegeneration).toBe(false);
  });
  it("does not claim that arbitrary provider-native audio can be changed without replacing the shot", () => {
    const result = analyzeEdit("Добавь тихую музыку в сцене 2", timeline);
    expect(result.intent).toBe("audio");
    expect(result.requiresVideoRegeneration).toBe(true);
    expect(result.affected[0].tracks).toEqual(["video", "audio"]);
  });
});
