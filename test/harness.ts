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
  attributes: Record<string, unknown>;
}

export interface SentLog { body: string; level: string; traceId?: string; attributes: Record<string, unknown> }

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
const otlpAttributes = (list: { key: string; value: OtlpValue }[] = []) => Object.fromEntries(list.map((a) => [a.key, otlpValue(a.value)]));

let current: Capture | undefined;
let latency = 0;
let answer = 200;
const original = globalThis.fetch;

// Effect's fetch client reads `fetch` once, so one stand-in stays and sends to the current capture.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const sent = current;
  const request = new Request(input, init);

  if (!sent || !request.url.includes("/api/")) return original(input, init);
  const body = await request.text();
  // Sentry answers after `latency`, and only then does the capture hold the data.
  await new Promise((resolve) => setTimeout(resolve, latency));
  const url = request.url;

  if (url.endsWith("/v1/traces")) {
    for (const rs of JSON.parse(body).resourceSpans) for (const ss of rs.scopeSpans) for (const s of ss.spans) {
      sent.spans.push({
        name: s.name, traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || undefined, failed: s.status?.code === 2,
        startMs: Number(BigInt(s.startTimeUnixNano) / 1000n) / 1000, endMs: Number(BigInt(s.endTimeUnixNano) / 1000n) / 1000,
        attributes: otlpAttributes(s.attributes),
      });
    }
  } else if (url.endsWith("/v1/logs")) {
    for (const rl of JSON.parse(body).resourceLogs) for (const sl of rl.scopeLogs) for (const l of sl.logRecords) {
      sent.logs.push({ body: String(otlpValue(l.body)), level: String(l.severityText).toLowerCase(), traceId: l.traceId || undefined, attributes: otlpAttributes(l.attributes) });
    }
  } else if (url.endsWith("/envelope/")) {
    const [, , event] = body.trim().split("\n").map((line) => JSON.parse(line));
    const exception = event.exception.values[0];
    sent.events.push({ type: exception.type, value: exception.value, traceId: event.contexts?.trace?.trace_id, tags: event.tags });
  }

  return new Response(null, { status: answer });
}) as typeof fetch;

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
 * come, and once before each step in `evictAt`, like a Worker evicted between two steps.
 */
export function engine(evictAt: string[] = [], events: Record<string, unknown> = {}) {
  const cache = new Map<string, unknown>();
  const evict = new Set(evictAt);

  return {
    async do(name: string, config: object, callback: (ctx: unknown) => Promise<unknown>) {
      if (evict.delete(name)) return new Promise(() => {});

      if (!cache.has(name)) cache.set(name, await callback({ attempt: 1, config, step: { name, count: 1 } }));

      return cache.get(name);
    },
    waitForEvent: (name: string) => (cache.has(name) ? Promise.resolve({ payload: cache.get(name) }) : (cache.set(name, events[name] ?? { state: "done" }), new Promise<void>(() => {}))),
  };
}

/** Lets exporters and transports send. */
export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
