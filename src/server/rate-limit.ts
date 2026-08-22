type Bucket = { count: number; resetsAt: number };
const buckets = new Map<string, Bucket>();

export function assertRateLimit(request: Request, scope: string, limit: number, windowMs: number): void {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const identity = forwarded || request.headers.get("x-real-ip") || "local";
  const key = `${scope}:${identity}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetsAt <= now) {
    buckets.set(key, { count: 1, resetsAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    const error = new Error(`Too many ${scope} requests. Retry after ${Math.ceil((bucket.resetsAt - now) / 1000)} seconds.`);
    Object.assign(error, { status: 429 });
    throw error;
  }
  bucket.count += 1;
  if (buckets.size > 10_000) {
    for (const [bucketKey, value] of buckets) if (value.resetsAt <= now) buckets.delete(bucketKey);
  }
}
