import { Context, type Effect } from "effect";
import type { Attributes, RecordedSpan } from "./model";

/**
 * The two things Effect's tracer and logger cannot do. App code uses `Effect.withSpan` and `Effect.log` for the rest.
 */
export interface TelemetrySink {
  /** Writes a span with a known id and start time, for a span that lasts across Worker invocations. */
  readonly recordSpan: (span: RecordedSpan) => Effect.Effect<void>;
  /** Makes a Sentry Issue, linked to the current span. */
  readonly reportError: (cause: unknown, attributes?: Attributes) => Effect.Effect<void>;
}

export class Telemetry extends Context.Service<Telemetry, TelemetrySink>()("app/Telemetry") {}
