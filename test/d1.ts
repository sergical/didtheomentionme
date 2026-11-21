import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

/** The D1 calls the app makes, run on an in-memory SQLite database with the real migrations. */
export function d1(db: Database) {
  return {
    async batch(statements: { run(): Promise<unknown> }[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => ((args = values), statement),
        all: async () => ({ success: true, results: db.query(sql).all(...(args as never[])), meta: { duration: 0, rows_read: 0, rows_written: 0 } }),
        first: async () => db.query(sql).get(...(args as never[])),
        run: async () => ({ success: true, results: [], meta: { duration: 0, rows_read: 0, rows_written: 0, changes: db.query(sql).run(...(args as never[])).changes } }),
        raw: async () => db.query(sql).values(...(args as never[])),
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
