import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { query, closeDatabase } from "../db.js";

const migrationPath = resolve(process.cwd(), "migrations/001_init.sql");

try {
  const sql = await readFile(migrationPath, "utf8");
  await query(sql);
  console.log("Database migration completed.");
} finally {
  await closeDatabase();
}
