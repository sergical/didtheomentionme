import { Cause, Context, Effect, Exit, Layer, Option, Scheduler, Scope } from "effect";
import type { Env } from "./env";
import { spanHeaders, telemetryLayer, type Attributes, type Telemetry } from "./telemetry";

/** The Worker's bindings, so Effect code gets them from its context instead of an `env` argument. */
export class Bindings extends Context.Service<Bindings, Env>()("app/Bindings") {}

export type App = Bindings | Telemetry;

/**
 * Runs an Effect with the bindings and the telemetry layer. The layer's scope closes after the Effect, which flushes
 * the OTLP exporter; with `waitUntil` the flush runs after the response. A failure rejects with its first error, so a
 * Workflow step sees the error it would have seen from plain code, for example a `NonRetryableError`.
 */
export async function runApp<A, E>(env: Env, effect: Effect.Effect<A, E, App>, waitUntil?: (promise: Promise<unknown>) => void, layer: Layer.Layer<Telemetry> = telemetryLayer(env)): Promise<A> {
  // Workers can drop the timers of a finished request. Effect's default scheduler is one for the isolate, so a
  // request that queued work on it could hang another. Each run gets its own scheduler, which runs work at once.
  const options = { scheduler: new Scheduler.MixedScheduler("sync") };
  const scope = Scope.makeUnsafe();
  const context = await Effect.runPromise(Layer.buildWithScope(Layer.merge(Layer.succeed(Bindings)(env), layer), scope), options);
  const exit = await Effect.runPromiseExit(Effect.provideContext(effect, context), options);
  const flush = Effect.runPromise(Scope.close(scope, Exit.void), options);
  if (waitUntil) waitUntil(flush);
  else await flush;
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

const clean = (attributes: Attributes) => Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined));

/** A span with a Sentry op, which Sentry reads from the `sentry.op` attribute. */
export const span = (name: string, op: string, attributes: Attributes = {}, kind: "server" | "internal" = "internal") =>
  Effect.withSpan(name, { kind, attributes: clean({ "sentry.op": op, ...attributes }) });

export const annotate = (attributes: Attributes) => Effect.annotateCurrentSpan(clean(attributes));

/** A storage or HTTP call, in the span names and attributes Sentry's SDKs use. `after` adds attributes from the result. */
const call = <A>(name: string, op: string, attributes: Attributes, run: () => Promise<A>, after?: (result: A) => Attributes) =>
  Effect.promise(run).pipe(Effect.tap((result) => (after ? annotate(after(result)) : Effect.void)), span(name, op, attributes));

export const bindings = Bindings;

/** `SELECT mentions videos`, as the Sentry SDK names a query span: the verb and the tables. */
export function sqlSummary(sql: string): string {
  const verb = sql.trim().split(/\s+/)[0].toUpperCase();
  const tables = [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][\w.]*)/gi)].map((m) => m[1]).filter((t, i, all) => all.indexOf(t) === i);
  return [verb, ...tables].join(" ");
}

type D1Meta = { meta?: { rows_read?: number; rows_written?: number; duration?: number } };
const d1Attributes = (result: unknown): Attributes => {
  const meta = (result as D1Meta)?.meta;
  return { "cloudflare.d1.rows_read": meta?.rows_read, "cloudflare.d1.rows_written": meta?.rows_written, "cloudflare.d1.duration": meta?.duration };
};

/**
 * One D1 statement, or a batch when `sql` lists several statements on their own lines. The span's description is the
 * whole SQL: Sentry finds N+1 and consecutive queries by the description, so two different queries must not share one.
 */
export const d1 = <A>(sql: string, run: (db: D1Database) => Promise<A>) => {
  const batch = sql.includes("\n;\n");
  const name = batch ? "D1 batch" : sqlSummary(sql);
  const attributes = {
    "sentry.description": sql,
    "db.system.name": "cloudflare-d1",
    "db.operation.name": batch ? "batch" : undefined,
    "db.query.text": sql,
    "db.query.summary": batch ? undefined : name,
  };
  return Effect.flatMap(bindings, (env) => call(name, "db.query", attributes, () => run(env.DB), d1Attributes));
};

/** The same statement for each set of values, in one D1 batch: one round trip instead of one per row. */
export const d1Batch = (query: string, rows: unknown[][]) =>
  rows.length === 0
    ? Effect.succeed([] as D1Result[])
    : d1(`${query}\n;\n`, (db) => db.batch(rows.map((values) => db.prepare(query).bind(...values))));

type R2Operation = "GetObject" | "PutObject" | "ListObjects" | "DeleteObject";
/** The SDK's span name and op for each R2 call. */
const R2_SPANS: Record<R2Operation, [string, string]> = {
  GetObject: ["r2_get", "object.get"],
  PutObject: ["r2_put", "object.put"],
  ListObjects: ["r2_list", "object.list"],
  DeleteObject: ["r2_delete", "object.delete"],
};

export const r2 = <A>(operation: R2Operation, key: string, run: (bucket: R2Bucket) => Promise<A>) =>
  Effect.flatMap(bindings, (env) => call(...R2_SPANS[operation], { "cloudflare.r2.operation": operation, "cloudflare.r2.bucket": "BUCKET", "cloudflare.r2.request.key": key }, () => run(env.BUCKET)));

export const vectorize = <A>(operation: string, count: number, run: (index: VectorizeIndex) => Promise<A>) =>
  Effect.flatMap(bindings, (env) => call(`vectorize.${operation}`, "db", { "db.system.name": "cloudflare-vectorize", "db.operation.name": operation, count }, () => run(env.POSTS)));

/** An outbound request. */
export const httpFetch = (url: string, init?: RequestInit) =>
  call(`${init?.method ?? "GET"} ${url}`, "http.client", { "http.request.method": init?.method ?? "GET", "url.full": url }, () => fetch(url, init), (res) => ({
    "http.response.status_code": res.status,
  }));

/** D1 shorthands: the SQL is also the span's query text. */
export const sql = {
  all: <T>(query: string, ...binds: unknown[]) =>
    Effect.map(d1(query, (db) => db.prepare(query).bind(...binds).all<T>()), (result) => result.results),
  first: <T>(query: string, ...binds: unknown[]) => d1(query, (db) => db.prepare(query).bind(...binds).first<T>()),
  run: (query: string, ...binds: unknown[]) => d1(query, (db) => db.prepare(query).bind(...binds).run()),
};

/** Headers that let the container continue the current trace. */
export const traceHeaders = Effect.map(Effect.option(Effect.currentSpan), (span) => spanHeaders(Option.getOrUndefined(span)));
