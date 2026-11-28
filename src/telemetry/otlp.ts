import { Effect, Layer, Option, Tracer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { OtlpExporter, OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";
import { entriesToAttributes } from "effect/observability/OtlpResource";
import { errorMessage, type Attributes, type RecordedSpan } from "./model";
import { Telemetry } from "./service";

/** The parts of a DSN that Sentry's OTLP and envelope endpoints need. */
export function parseDsn(dsn: string) {
  const url = new URL(dsn);
  const projectId = url.pathname.replace(/^\/+|\/+$/g, "");
  const api = `${url.protocol}//${url.host}/api/${projectId}`;

  return { key: url.username, otlp: `${api}/integration/otlp`, envelope: `${api}/envelope/` };
}

const service = (environment: string) => ({ serviceName: "didtheomentionme", attributes: { "deployment.environment": environment, "deployment.environment.name": environment } });

const clean = (attributes: Attributes = {}) =>
  Object.entries(attributes).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined);

const nanos = (ms: number) => `${BigInt(Math.round(ms * 1000)) * 1000n}`;

/** One OTLP/JSON span, in the shape the Effect exporter sends. */
export const otlpSpan = (span: RecordedSpan) => ({
  traceId: span.traceId,
  spanId: span.spanId,
  parentSpanId: span.parentSpanId,
  name: span.name,
  kind: 1,
  startTimeUnixNano: nanos(span.startMs),
  endTimeUnixNano: nanos(span.endMs),
  attributes: entriesToAttributes([["sentry.op", span.op], ["sentry.description", span.name], ...clean(span.attributes)]),
  status: { code: span.failed ? 2 : 1 },
});

/** Stack lines in the V8 format, oldest call first, as Sentry wants them. */
export function stackFrames(stack: string | undefined) {
  const frames = [];

  for (const line of (stack ?? "").split("\n")) {
    const match = line.match(/^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);

    if (match) frames.push({ function: match[1] ?? "?", filename: match[2], lineno: Number(match[3]), colno: Number(match[4]), in_app: !match[2].includes("node_modules") });
  }

  return frames.reverse();
}

/** One thrown value on its way to Sentry as an Issue. */
export interface ErrorReport {
  cause: unknown;
  attributes: Attributes;
  /** The span the error happened in, when there is one. */
  span?: { traceId: string; spanId: string };
  now?: number;
  environment?: string;
}

/** A Sentry error event for one exception, linked to the current span. OTLP has no way to make an Issue. */
export function errorEnvelope({ cause, attributes, span, now = Date.now(), environment = "production" }: ErrorReport) {
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const err = cause instanceof Error ? cause : new Error(errorMessage(cause));

  const event = {
    event_id: eventId,
    timestamp: now / 1000,
    platform: "javascript",
    level: "error",
    environment,
    exception: { values: [{ type: err.name, value: err.message, stacktrace: { frames: stackFrames(err.stack) }, mechanism: { type: "otlp.report", handled: true } }] },
    tags: Object.fromEntries(clean(attributes).map(([k, v]) => [k, String(v)])),
    contexts: span ? { trace: { trace_id: span.traceId, span_id: span.spanId } } : undefined,
  };

  return `${JSON.stringify({ event_id: eventId, sent_at: new Date(now).toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

/** Exports traces and logs to Sentry with Effect's own OTLP exporter. Closing the layer's scope flushes them. */
export function otlpLayer(dsn: string, environment = "production") {
  const { key, otlp, envelope } = parseDsn(dsn);
  const SERVICE = service(environment);
  const auth = { "x-sentry-auth": `sentry sentry_key=${key}` };

  const post = (url: string, body: string, contentType: string, headers: Record<string, string>) =>
    HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.setHeaders(headers), HttpClientRequest.bodyText(body, contentType))).pipe(
      Effect.flatMap((res) => (res.status < 300 ? Effect.void : Effect.logWarning(`Sentry answered ${res.status} for ${url}`))),
      Effect.catch((err) => Effect.logWarning(`Sentry request failed: ${errorMessage(err)}`)),
      Effect.withTracerEnabled(false),
    );

  const telemetry = Layer.effect(Telemetry)(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const send = (url: string, body: string, contentType: string, headers: Record<string, string>) =>
        post(url, body, contentType, headers).pipe(Effect.provideService(HttpClient.HttpClient, client));

      return Telemetry.of({
        recordSpan: (span) =>
          send(`${otlp}/v1/traces`, JSON.stringify({ resourceSpans: [{ resource: { attributes: entriesToAttributes([["service.name", SERVICE.serviceName], ...Object.entries(SERVICE.attributes)]) }, scopeSpans: [{ scope: { name: "didtheomentionme" }, spans: [otlpSpan(span)] }] }] }), "application/json", auth),
        reportError: (cause, attributes = {}) =>
          Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
            send(envelope, errorEnvelope({ cause, attributes, span: Option.getOrUndefined(span), environment }), "application/x-sentry-envelope", {
              "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=didtheomentionme-otlp/1.0`,
            })),
      });
    }),
  );

  // Sentry shows a span's description, which it does not take from an OTLP span's name.
  const tracer = Layer.effect(Tracer.Tracer)(
    Effect.map(OtlpTracer.make({ url: `${otlp}/v1/traces`, headers: auth, resource: SERVICE, maxBatchSize: 512, exportInterval: "1 second", shutdownTimeout: "10 seconds" }), (otlpTracer) =>
      Tracer.make({
        span(options) {
          const span = otlpTracer.span(options);
          span.attribute("sentry.description", options.name);

          return span;
        },
        context: otlpTracer.context,
      })),
  );

  // Traces and logs only: Sentry takes no OTLP metrics, and Effect's combined layer would post them anyway.
  const exporter = Layer.mergeAll(
    tracer,
    OtlpLogger.layer({ url: `${otlp}/v1/logs`, headers: auth, resource: SERVICE, maxBatchSize: 512, exportInterval: "1 second", shutdownTimeout: "10 seconds" }),
  ).pipe(Layer.provideMerge(OtlpExporter.layerFlusher), Layer.provide(OtlpSerialization.layerJson));

  return Layer.mergeAll(telemetry, exporter);
}
