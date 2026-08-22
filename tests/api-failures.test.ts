import { describe, expect, it } from "vitest";
import { classifyFailure, retryDecision } from "@/server/movie/retry";

describe("API failure policy", () => {
  it("pauses on exhausted quota without a retry loop", () => {
    const error = Object.assign(new Error("RESOURCE_EXHAUSTED quota"), { status: 429 });
    expect(classifyFailure(error)).toBe("quota");
    expect(retryDecision({ failure: "quota", attempt: 1, maxAttempts: 3 })).toEqual({ retry: false, pauseProject: true, delayMs: 0 });
  });
  it("uses bounded exponential backoff for transient errors", () => {
    expect(retryDecision({ failure: "server", attempt: 1, maxAttempts: 3, baseMs: 1000 })).toEqual({ retry: true, pauseProject: false, delayMs: 2300 });
    expect(retryDecision({ failure: "server", attempt: 3, maxAttempts: 3 })).toEqual({ retry: false, pauseProject: false, delayMs: 0 });
  });
  it("does not automatically retry moderation rejection", () => {
    expect(retryDecision({ failure: "moderation", attempt: 1, maxAttempts: 3 }).retry).toBe(false);
  });
});
