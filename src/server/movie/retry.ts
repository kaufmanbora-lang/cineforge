export type FailureClass = "quota" | "billing" | "authentication" | "permission" | "model" | "rate-limit" | "timeout" | "server" | "moderation" | "corrupt" | "upload" | "network" | "fatal";

export function classifyFailure(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const record = typeof error === "object" && error ? error as Record<string, unknown> : {};
  const status = [record.status, record.statusCode, record.httpStatus, record.code]
    .map((value) => typeof value === "number" || (typeof value === "string" && /^\d{3}$/.test(value)) ? Number(value) : undefined)
    .find((value) => value !== undefined && Number.isFinite(value));
  const code = record.code === undefined ? "" : String(record.code).toLowerCase();
  const probe = `${code} ${message}`;
  // The fallback provider's explicit server status is authoritative. If an
  // earlier provider mentioned billing but Gemini returned 503, retry Gemini.
  if (status && status >= 500) return "server";
  // Google's paid-tier spend limit is a rolling short window and must be
  // retried like RPM, not mistaken for an exhausted balance. Only explicit
  // daily/credit depletion signals require a manual quota pause.
  if ((status === 429 || /google_quota_exhausted|insufficient_quota/.test(code)) && (/google_quota_exhausted|insufficient_quota/.test(code) || /daily|per day|requests per day|credit limit|prepay.*(?:empty|depleted)|no credits|credits? remaining.*\b0\b|limit(?:ed)?[^.]{0,30}\b0\b/.test(probe))) return "quota";
  if (status === 429 || /google_rate_limit|resource_exhausted|rate.?limit/.test(code)) return "rate-limit";
  if (/google_billing_not_ready|billing (?:account )?(?:is )?(?:inactive|required|disabled)|prepay (?:balance )?(?:is )?(?:depleted|empty)|payment required|credit balance (?:is )?(?:depleted|empty)|no credits|оплата (?:не активна|требуется)/.test(probe)) return "billing";
  if (status === 401 || /authentication|unauthenticated|api[_ -]?key.*invalid/.test(probe)) return "authentication";
  if (/moderation|safety|blocked|безопасност/.test(probe)) return "moderation";
  if (status === 403 || /permission|access restricted/.test(probe)) return "permission";
  if (status === 404 || /model_unavailable|model_not_found/.test(probe)) return "model";
  if (status === 408 || /timeout/.test(message)) return "timeout";
  if (/corrupt|invalid media|ffprobe/.test(message)) return "corrupt";
  if (/upload|s3/.test(message)) return "upload";
  if (/network|econnreset|econnrefused|connection refused|fetch failed/.test(message)) return "network";
  return "fatal";
}

export function retryDecision(input: { failure: FailureClass; attempt: number; maxAttempts: number; baseMs?: number }): {
  retry: boolean;
  pauseProject: boolean;
  delayMs: number;
} {
  if (["quota", "billing", "authentication", "permission", "model"].includes(input.failure)) return { retry: false, pauseProject: true, delayMs: 0 };
  if (input.failure === "moderation" || input.failure === "fatal") return { retry: false, pauseProject: false, delayMs: 0 };
  if (input.failure === "rate-limit" && input.attempt >= input.maxAttempts) return { retry: false, pauseProject: true, delayMs: 0 };
  if (input.attempt >= input.maxAttempts) return { retry: false, pauseProject: false, delayMs: 0 };
  const exponential = (input.baseMs ?? 1_000) * 2 ** input.attempt;
  const deterministicJitter = Math.round(exponential * 0.15);
  return { retry: true, pauseProject: false, delayMs: Math.min(60_000, exponential + deterministicJitter) };
}

export function rateLimitRecoveryDecision(input: {
  attempt: number;
  maxAttempts: number;
  cooldownCount?: number;
  retryAfterMs?: number;
  maxCooldowns?: number;
}): {
  retry: boolean;
  pauseProject: boolean;
  delayMs: number;
  resetAttempts: boolean;
  nextCooldownCount: number;
} {
  const cooldownCount = Math.max(0, Math.floor(input.cooldownCount ?? 0));
  const providerDelay = Math.max(0, Math.floor(input.retryAfterMs ?? 0));
  if (input.attempt < input.maxAttempts) {
    const shortRetry = retryDecision({ failure: "rate-limit", attempt: input.attempt, maxAttempts: input.maxAttempts, baseMs: 15_000 });
    return {
      ...shortRetry,
      delayMs: Math.max(shortRetry.delayMs, providerDelay),
      resetAttempts: false,
      nextCooldownCount: cooldownCount,
    };
  }

  const maxCooldowns = Math.max(1, Math.floor(input.maxCooldowns ?? 4));
  if (cooldownCount >= maxCooldowns) {
    return { retry: false, pauseProject: true, delayMs: 0, resetAttempts: false, nextCooldownCount: cooldownCount };
  }

  // A short RPM/concurrency window can outlive the normal three job attempts.
  // Start a new bounded attempt cycle after a durable cooldown instead of
  // forcing the user to resume the whole project manually.
  const cooldownMs = Math.min(8 * 60_000, 60_000 * 2 ** cooldownCount);
  return {
    retry: true,
    pauseProject: false,
    delayMs: Math.max(cooldownMs, providerDelay),
    resetAttempts: true,
    nextCooldownCount: cooldownCount + 1,
  };
}
