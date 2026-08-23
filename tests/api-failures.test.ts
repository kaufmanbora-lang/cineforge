import { describe, expect, it } from "vitest";
import { classifyFailure, retryDecision } from "@/server/movie/retry";
import { isRetryableDatabaseConnectionError } from "@/server/db";

describe("API failure policy", () => {
  it("pauses on exhausted quota without a retry loop", () => {
    const error = Object.assign(new Error("RESOURCE_EXHAUSTED quota"), { status: 429 });
    expect(classifyFailure(error)).toBe("quota");
    expect(retryDecision({ failure: "quota", attempt: 1, maxAttempts: 3 })).toEqual({ retry: false, pauseProject: true, delayMs: 0 });
  });
  it("does not mistake a paid-tier 429 for inactive billing", () => {
    const error = Object.assign(new Error("RESOURCE_EXHAUSTED: spend limit for billing tier 1"), { status: 429 });
    expect(classifyFailure(error)).toBe("quota");
  });
  it("does not treat generic billing metadata as a payment failure", () => {
    const error = Object.assign(new Error("Billing metadata failed a different precondition"), { status: 400 });
    expect(classifyFailure(error)).toBe("fatal");
  });
  it("pauses on billing and key failures so completed checkpoints stay intact", () => {
    const billing = Object.assign(new Error("Google billing failed_precondition"), { status: 400, code: "GOOGLE_BILLING_NOT_READY" });
    const authentication = Object.assign(new Error("invalid API key"), { status: 401, code: "GOOGLE_AUTHENTICATION" });
    expect(classifyFailure(billing)).toBe("billing");
    expect(classifyFailure(authentication)).toBe("authentication");
    expect(retryDecision({ failure: "billing", attempt: 1, maxAttempts: 3 })).toEqual({ retry: false, pauseProject: true, delayMs: 0 });
    expect(retryDecision({ failure: "authentication", attempt: 1, maxAttempts: 3 })).toEqual({ retry: false, pauseProject: true, delayMs: 0 });
  });
  it("uses bounded exponential backoff for transient errors", () => {
    expect(retryDecision({ failure: "server", attempt: 1, maxAttempts: 3, baseMs: 1000 })).toEqual({ retry: true, pauseProject: false, delayMs: 2300 });
    expect(retryDecision({ failure: "server", attempt: 3, maxAttempts: 3 })).toEqual({ retry: false, pauseProject: false, delayMs: 0 });
  });
  it("retries a fallback provider 503 even when an earlier provider reported no credits", () => {
    const error = Object.assign(new Error("OpenAI: no credits. Gemini: temporarily unavailable"), { status: 503 });
    expect(classifyFailure(error)).toBe("server");
    expect(retryDecision({ failure: "server", attempt: 1, maxAttempts: 3 })).toEqual({ retry: true, pauseProject: false, delayMs: 2300 });
  });
  it("classifies a refused PostgreSQL connection as a recoverable network failure", () => {
    expect(classifyFailure(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }))).toBe("network");
  });
  it("does not automatically retry moderation rejection", () => {
    expect(classifyFailure(Object.assign(new Error("Google отклонил кадр по правилам безопасности"), { code: "GOOGLE_MODERATION" }))).toBe("moderation");
    expect(retryDecision({ failure: "moderation", attempt: 1, maxAttempts: 3 }).retry).toBe(false);
  });
  it("recognizes temporary PostgreSQL connection refusal without retrying arbitrary database errors", () => {
    expect(isRetryableDatabaseConnectionError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isRetryableDatabaseConnectionError(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
  });
});
