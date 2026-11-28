import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { Schema } from "effect";

/** A member of a binding that no test uses. A call fails the test instead of answering something made up. */
export const unused = (name: string) => (): never => {
  throw new Error(`${name} is not part of this fake`);
};

/** The values the app binds to a statement. Anything else fails the test at `bind`. */
const bound = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]))));

const meta = (changes = 0) => ({ duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: changes > 0, changes });

/** One statement on the SQLite database. Each call answers after `latencyMs`. */
function statement(db: Database, sql: string, latencyMs: number): D1PreparedStatement {
  let args: ReturnType<typeof bound> = [];
  const answered = () => new Promise<void>((resolve) => (latencyMs ? setTimeout(resolve, latencyMs) : resolve()));

  const prepared: D1PreparedStatement = {
    bind: (...values) => ((args = bound(values)), prepared),
    first: async <T>(column?: string) => {
      if (column !== undefined) return unused("first(column)")();
      await answered();

      return db.query<T, typeof args>(sql).get(...args);
    },
    all: async <T>() => {
      await answered();

      return { success: true, results: db.query<T, typeof args>(sql).all(...args), meta: meta() };
    },
    run: async () => {
      await answered();

      return { success: true, results: [], meta: meta(db.query(sql).run(...args).changes) };
    },
    raw: unused("raw"),
  };

  return prepared;
}

/** The D1 calls the app makes, run on an in-memory SQLite database with the real migrations. */
export function d1(db: Database, latencyMs = 0): D1Database {
  return {
    prepare: (sql) => statement(db, sql, latencyMs),
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<T>[] = [];

      for (const prepared of statements) results.push(await prepared.run<T>());

      return results;
    },
    async exec(sql) {
      db.exec(sql);

      return { count: 1, duration: 0 };
    },
    withSession: unused("withSession"),
    dump: unused("dump"),
  };
}

export function migrated(): Database {
  const db = new Database(":memory:");

  for (const file of readdirSync("migrations").sort()) db.exec(readFileSync(`migrations/${file}`, "utf8"));

  return db;
}
