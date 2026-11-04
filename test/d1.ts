import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

/** The D1 calls the app makes, run on an in-memory SQLite database with the real migrations. */
export function d1(db: Database) {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => ((args = values), statement),
        all: async () => ({ results: db.query(sql).all(...(args as never[])) }),
        first: async () => db.query(sql).get(...(args as never[])),
        run: async () => ({ meta: { changes: db.query(sql).run(...(args as never[])).changes } }),
      };
      return statement;
    },
  };
}

export function migrated(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync("migrations").sort()) db.exec(readFileSync(`migrations/${file}`, "utf8"));
  return db;
}
