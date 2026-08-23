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
  // HTTP 429 is a rate/quota signal even when Google mentions the account's
  // billing tier in its explanatory metadata. It must never be converted into
  // a false "payment inactive" pause.
  if ((status === 429 || /google_quota_exhausted|insufficient_quota/.test(code)) && (/google_quota_exhausted|insufficient_quota/.test(code) || /daily|per day|requests per day|spend limit|spending limit|credit limit|prepay.*(?:empty|depleted)|no credits|credits? remaining.*\b0\b|limit(?:ed)?[^.]{0,30}\b0\b/.test(probe))) return "quota";
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
