import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://cineforge:cineforge@localhost:5432/cineforge";
const pool = new Pool({ connectionString: databaseUrl });

try {
  const migrationPath = path.resolve(process.cwd(), "db/migrations/001_init.sql");
  await pool.query(await readFile(migrationPath, "utf8"));
  process.stdout.write("CineForge database migration complete.\n");
} finally {
  await pool.end();
}
