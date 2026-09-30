import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withTransaction, closeDatabase } from "../db.js";

const migrationsDir = resolve(process.cwd(), "migrations");

try {
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  if (!files.length) {
    throw new Error("No migration files found");
  }

  await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["wallet-business-ai:migrations"]
    );

    for (const file of files) {
      const applied = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [file]
      );

      if (applied.rows[0]) {
        console.log(`Skipping applied migration: ${file}`);
        continue;
      }

      const sql = await readFile(resolve(migrationsDir, file), "utf8");

      console.log(`Applying migration: ${file}`);
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
        [file, file]
      );
    }
  });

  console.log("Database migrations completed.");
} finally {
  await closeDatabase();
}
