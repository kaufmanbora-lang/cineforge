import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

declare global {
  var __cineforgePool: Pool | undefined;
}

export function db(): Pool {
  if (!globalThis.__cineforgePool) {
    const pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: env().NODE_ENV === "production" ? 20 : 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // pg emits idle-client failures on the Pool itself. Without a listener Node
    // treats them as uncaught events and terminates the background worker.
    pool.on("error", (error) => process.stderr.write(`PostgreSQL pool connection lost: ${error.message}\n`));
    globalThis.__cineforgePool = pool;
  }
  return globalThis.__cineforgePool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await withDatabaseConnectionRetry(() => db().query<T>(text, values));
  return result.rows;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await withDatabaseConnectionRetry(() => db().connect());
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const DATABASE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;

async function withDatabaseConnectionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableDatabaseConnectionError(error) || attempt >= DATABASE_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, DATABASE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export function isRetryableDatabaseConnectionError(error: unknown): boolean {
  const record = typeof error === "object" && error ? error as { code?: string; message?: string } : {};
  const probe = `${record.code ?? ""} ${record.message ?? (error instanceof Error ? error.message : "")}`.toLowerCase();
  return /econnrefused|connection refused|57p03|cannot connect now|connection terminated unexpectedly/.test(probe);
}
