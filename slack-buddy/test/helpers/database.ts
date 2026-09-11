import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

/** Execute repository SQL against SQLite; only the D1 transport is adapted. */
export function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const prepare = (sql: string, values: unknown[] = []): D1PreparedStatement =>
    ({
      bind: (...next: unknown[]) => prepare(sql, next),
      run: async () => {
        const result = sqlite.prepare(sql).run(...(values as never[]));
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        };
      },
      all: async () => ({
        success: true,
        results: sqlite.prepare(sql).all(...(values as never[])),
        meta: {},
      }),
      first: async () =>
        sqlite.prepare(sql).get(...(values as never[])) ?? null,
    }) as unknown as D1PreparedStatement;
  const db = {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite, close: () => sqlite.close() };
}
