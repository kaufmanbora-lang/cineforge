import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

declare global {
  var __cineforgePool: Pool | undefined;
}

export function db(): Pool {
  if (!globalThis.__cineforgePool) {
    globalThis.__cineforgePool = new Pool({
      connectionString: env().DATABASE_URL,
      max: env().NODE_ENV === "production" ? 20 : 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return globalThis.__cineforgePool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await db().query<T>(text, values);
  return result.rows;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
