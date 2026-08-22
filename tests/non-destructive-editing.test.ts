import { describe, expect, it } from "vitest";
import { analyzeEdit } from "@/server/movie/impact-analysis";

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
});
