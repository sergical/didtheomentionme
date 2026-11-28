import type { WorkflowStepConfig, WorkflowStepContext } from "cloudflare:workers";
import type { Json } from "../src/env";
import type { DurableSteps } from "../src/steps";
import type { Attributes } from "../src/telemetry";

export const DSN = "https://public@o1.ingest.example.com/2";

/** A span as the OTLP exporter sent it. */
export interface SentSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  failed: boolean;
  startMs: number;
  endMs: number;
  attributes: Attributes;
}

export interface SentLog { body: string; level: string; traceId?: string; attributes: Attributes }

export interface SentEvent { type: string; value: string; traceId?: string; tags: Record<string, string> }

export interface Capture {
  spans: SentSpan[];
  logs: SentLog[];
  events: SentEvent[];
  named(name: string): SentSpan[];
}

function capture(): Capture {
  const spans: SentSpan[] = [];

  return { spans, logs: [], events: [], named: (name) => spans.filter((s) => s.name === name) };
}

type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };

const otlpValue = (v: OtlpValue) => v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : v.doubleValue ?? v.boolValue);
const otlpAttributes = (list: { key: string; value: OtlpValue }[] = []): Attributes => Object.fromEntries(list.map((a) => [a.key, otlpValue(a.value)]));
const ms = (unixNano: string) => Number(BigInt(unixNano) / 1000n) / 1000;

function recordSpans(sent: Capture, body: string) {
  for (const rs of JSON.parse(body).resourceSpans) for (const ss of rs.scopeSpans) for (const s of ss.spans) {
    sent.spans.push({
      name: s.name, traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || undefined, failed: s.status?.code === 2,
      startMs: ms(s.startTimeUnixNano), endMs: ms(s.endTimeUnixNano), attributes: otlpAttributes(s.attributes),
    });
  }
}

function recordLogs(sent: Capture, body: string) {
  for (const rl of JSON.parse(body).resourceLogs) for (const sl of rl.scopeLogs) for (const l of sl.logRecords) {
    sent.logs.push({ body: String(otlpValue(l.body)), level: String(l.severityText).toLowerCase(), traceId: l.traceId || undefined, attributes: otlpAttributes(l.attributes) });
  }
}

function recordEvent(sent: Capture, body: string) {
  const [, , event] = body.trim().split("\n").map((line) => JSON.parse(line));
  const exception = event.exception.values[0];
  sent.events.push({ type: exception.type, value: exception.value, traceId: event.contexts?.trace?.trace_id, tags: event.tags });
}

/** What each Sentry endpoint's request adds to the capture. */
const RECORDERS = [["/v1/traces", recordSpans], ["/v1/logs", recordLogs], ["/envelope/", recordEvent]] as const;

/**
 * Answers `fetch` with `answer`, which can send the request on to the `fetch` it replaced. A test puts the old
 * `fetch` back when it ends.
 */
export function replaceFetch(answer: (request: Request, next: () => Promise<Response>) => Promise<Response>) {
  const before = globalThis.fetch;
  const send = (input: RequestInfo | URL, init?: RequestInit) => answer(new Request(input, init), () => before(input, init));
  globalThis.fetch = Object.assign(send, { preconnect: before.preconnect });
}

let current: Capture | undefined;
let latency = 0;
let answer = 200;

// Effect's fetch client reads `fetch` once, so one stand-in stays and sends to the current capture.
replaceFetch(async (request, next) => {
  const sent = current;

  if (!sent || !request.url.includes("/api/")) return next();
  const body = await request.text();
  // Sentry answers after `latency`, and only then does the capture hold the data.
  await new Promise((resolve) => setTimeout(resolve, latency));

  for (const [path, record] of RECORDERS) if (request.url.endsWith(path)) record(sent, body);

  return new Response(null, { status: answer });
});

/** Captures what the OTLP exporter sends to Sentry until `restore`. */
export function captureOtlp(options: { latencyMs?: number; status?: number } = {}): Capture & { restore: () => void } {
  const sent = capture();
  current = sent;
  latency = options.latencyMs ?? 0;
  answer = options.status ?? 200;

  return { ...sent, restore: () => { if (current === sent) current = undefined; } };
}

/**
 * Runs finished steps from the cache, like the Workflows engine on replay. It suspends at an event that has not
 * come, and once before each step in `evictAt`, like a Worker evicted between two steps. An event that is not in
 * `events` comes with a finished job.
 */
export function engine(evictAt: string[] = [], events = new Map<string, Json>()): DurableSteps {
  const cache = new Map<string, unknown>();
  const evict = new Set(evictAt);
  const suspended = <T>() => new Promise<T>(() => {});

  // SAFETY: a step or event name is used once in a run, so the value kept under it is the result of the step that
  // asks for it. Workflows gives a replayed step its stored result on the same promise.
  const kept = <T>(name: string) => cache.get(name) as T;

  return {
    async do<T>(name: string, _config: WorkflowStepConfig, callback: (ctx: WorkflowStepContext) => Promise<T>) {
      if (evict.delete(name)) return suspended<T>();

      if (!cache.has(name)) cache.set(name, await callback({ attempt: 1, config: {}, step: { name, count: 1 } }));

      return kept<T>(name);
    },
    waitForEvent<T>(name: string, { type }: { type: string }) {
      if (cache.has(name)) return Promise.resolve({ payload: kept<Readonly<T>>(name), timestamp: new Date(), type });
      cache.set(name, events.get(name) ?? { state: "done" });

      return suspended();
    },
  };
}

/** Lets exporters and transports send. */
export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
