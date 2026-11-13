import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export function createDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_SIZE ?? 10),
    ssl:
      process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  return pool;
}

export async function migrate(pool: pg.Pool) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    try {
      await pool.query(sql);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 15) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}
