export type FailureClass = "quota" | "rate-limit" | "timeout" | "server" | "moderation" | "corrupt" | "upload" | "network" | "fatal";

export function classifyFailure(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : undefined;
  if (status === 429 && /quota|resource_exhausted/.test(message)) return "quota";
  if (status === 429) return "rate-limit";
  if (status === 408 || /timeout/.test(message)) return "timeout";
  if (status && status >= 500) return "server";
  if (/moderation|safety|blocked/.test(message)) return "moderation";
  if (/corrupt|invalid media|ffprobe/.test(message)) return "corrupt";
  if (/upload|s3/.test(message)) return "upload";
  if (/network|econnreset|fetch failed/.test(message)) return "network";
  return "fatal";
}

export function retryDecision(input: { failure: FailureClass; attempt: number; maxAttempts: number; baseMs?: number }): {
  retry: boolean;
  pauseProject: boolean;
  delayMs: number;
} {
  if (input.failure === "quota") return { retry: false, pauseProject: true, delayMs: 0 };
  if (input.failure === "moderation" || input.failure === "fatal") return { retry: false, pauseProject: false, delayMs: 0 };
  if (input.attempt >= input.maxAttempts) return { retry: false, pauseProject: false, delayMs: 0 };
  const exponential = (input.baseMs ?? 1_000) * 2 ** input.attempt;
  const deterministicJitter = Math.round(exponential * 0.15);
  return { retry: true, pauseProject: false, delayMs: Math.min(60_000, exponential + deterministicJitter) };
}
