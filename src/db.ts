import pg from "pg";
import { env } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool() {
  if (pool) return pool;

  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined
  });

  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
) {
  return getPool().query<T>(text, values);
}

export async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
