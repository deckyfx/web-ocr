/**
 * CLI migration runner — run with: bun run src/db/migrate.ts
 * Uses drizzle-kit push for schema sync (no separate migration files needed for SQLite).
 */
import { db } from "./index";
import { sql } from "drizzle-orm";

async function migrate(): Promise<void> {
  console.log("Running migrations…");

  // Ensure WAL mode and FK enforcement even in migration context
  await db.run(sql`PRAGMA journal_mode = WAL`);
  await db.run(sql`PRAGMA foreign_keys = ON`);

  // drizzle-kit generates migrations into src/db/migrations/
  // They are applied automatically via MigrationManager at server startup.
  // This script is kept for manual / CI use.
  const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });

  console.log("Migrations complete.");
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
