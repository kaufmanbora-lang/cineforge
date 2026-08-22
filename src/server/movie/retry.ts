export type FailureClass = "quota" | "billing" | "authentication" | "permission" | "model" | "rate-limit" | "timeout" | "server" | "moderation" | "corrupt" | "upload" | "network" | "fatal";

export function classifyFailure(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : undefined;
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code).toLowerCase() : "";
  const probe = `${code} ${message}`;
  if (/billing|prepay|payment|credit balance|no credits|оплат/.test(probe)) return "billing";
  if (status === 401 || /authentication|unauthenticated|api[_ -]?key.*invalid/.test(probe)) return "authentication";
  if (status === 403 || /permission|access restricted/.test(probe)) return "permission";
  if (status === 404 || /model_unavailable|model_not_found/.test(probe)) return "model";
  if (status === 429 && /quota|resource_exhausted|квот/.test(probe)) return "quota";
  if (status === 429) return "rate-limit";
  if (status === 408 || /timeout/.test(message)) return "timeout";
  if (status && status >= 500) return "server";
  if (/moderation|safety|blocked/.test(message)) return "moderation";
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
  if (input.attempt >= input.maxAttempts) return { retry: false, pauseProject: false, delayMs: 0 };
  const exponential = (input.baseMs ?? 1_000) * 2 ** input.attempt;
  const deterministicJitter = Math.round(exponential * 0.15);
  return { retry: true, pauseProject: false, delayMs: Math.min(60_000, exponential + deterministicJitter) };
}
