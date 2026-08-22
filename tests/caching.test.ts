import { describe, expect, it } from "vitest";
import { contentHash, stableStringify } from "@/server/movie/content-hash";

describe("content-addressed generation cache", () => {
  it("produces the same hash for semantically identical unordered objects", () => {
    expect(contentHash({ prompt: "x", settings: { seed: 42, model: "veo" } })).toBe(contentHash({ settings: { model: "veo", seed: 42 }, prompt: "x" }));
  });
  it("invalidates only when a generation input changes", () => {
    const base = { prompt: "red phone", references: ["face"], model: "veo", seed: 42 };
    expect(contentHash(base)).not.toBe(contentHash({ ...base, prompt: "black phone" }));
    expect(stableStringify(base)).toContain("references");
  });
});
