import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { otlpLayer } from "./otlp";
import { Telemetry } from "./service";

export * from "./model";
export { Telemetry } from "./service";

const offLayer = Layer.succeed(Telemetry)(Telemetry.of({ recordSpan: () => Effect.void, reportError: () => Effect.void }));

/** Telemetry goes to the Sentry project of `SENTRY_DSN`; without a DSN it is off. */
export const telemetryLayer = (env: { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string }): Layer.Layer<Telemetry> =>
  env.SENTRY_DSN ? otlpLayer(env.SENTRY_DSN, env.SENTRY_ENVIRONMENT).pipe(Layer.provide(FetchHttpClient.layer)) : offLayer;
