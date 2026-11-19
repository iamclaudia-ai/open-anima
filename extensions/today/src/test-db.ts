import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** An in-memory database with the Today tables, built from the real migrations. */
export function todayTestDb(): Database {
  const db = new Database(":memory:");
  const migrations = join(import.meta.dir, "..", "..", "..", "packages", "gateway", "migrations");
  for (const file of [
    "042-today-items.sql",
    "043-today-item-session.sql",
    "044-today-item-question.sql",
    "045-today-item-session-stack.sql",
    "046-today-item-nudged.sql",
    "047-today-item-state-since.sql",
    "048-today-note-picks.sql",
    "049-today-item-top-at.sql",
    "051-today-item-follow-up.sql",
    "052-today-promote-section.sql",
  ]) {
    const sql = readFileSync(join(migrations, file), "utf8");
    db.exec(sql.split("-- Down")[0]!.replace("-- Up", ""));
  }
  return db;
}
