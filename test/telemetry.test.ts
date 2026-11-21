import { describe, expect, test } from "bun:test";
import { isExpiredFrame } from "../src/retention";
import { sqlSummary } from "../src/runtime";
import { frameAttributes, redactImages, usageAttributes, workflowRootSpanId, workflowTraceId } from "../src/telemetry";
import { errorEnvelope, otlpSpan, parseDsn, stackFrames } from "../src/telemetry/otlp";

describe("telemetry model", () => {
  test("replaces reader data URLs with the exact frame URL", () => {
    const attrs = frameAttributes({ videoId: "Ka0p5tUUmgg", second: 390, size: "f1920" });
    const result = redactImages('{"url":"data:image/jpeg;base64,AAAA"}', attrs["app.frame.url"]);
    expect(JSON.parse(result).url).toBe(attrs["app.frame.url"]);
    expect(attrs["app.frame.youtube_url"]).toEndWith("&t=390s");
    expect(redactImages("data:image/jpeg;base64,AAAA", undefined)).toBe("[image/jpeg, 0 KB]");
  });

  test("prices tokens with Cloudflare's list, and marks estimates", () => {
    expect(usageAttributes("@cf/qwen/qwen3.8-27b", 1_000_000, 1_000_000)["gen_ai.cost.total_tokens"]).toBeCloseTo(0.45 + 3.2, 10);
    expect(usageAttributes("@cf/baai/bge-m3", 100, 0, true)["app.tokens_estimated"]).toBe(true);
    expect(usageAttributes("@cf/unknown/model", 100)["gen_ai.cost.total_tokens"]).toBeUndefined();
  });

  test("a Workflow instance gets the trace id the Sentry SDK gives it, and a stable root span id", async () => {
    // The SDK hashes the instance id with SHA-1 and keeps 16 bytes.
    expect(await workflowTraceId("abc")).toBe("a9993e364706816aba3e25717850c26c");
    expect(await workflowRootSpanId("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(await workflowRootSpanId("abc")).toBe(await workflowRootSpanId("abc"));
  });

  test("names a query span by its verb and tables, as the SDK does", () => {
    expect(sqlSummary("SELECT m.id FROM mentions m JOIN videos v ON v.id = m.video_id")).toBe("SELECT mentions videos");
    expect(sqlSummary("INSERT OR IGNORE INTO stale_vectors (a) SELECT b FROM mentions")).toBe("INSERT stale_vectors mentions");
    expect(sqlSummary("UPDATE videos SET status = ?")).toBe("UPDATE videos");
  });
});

describe("OTLP exporter", () => {
  test("finds Sentry's OTLP and envelope endpoints in a DSN", () => {
    expect(parseDsn("https://abc@o1.ingest.us.sentry.io/42")).toEqual({
      key: "abc",
      otlp: "https://o1.ingest.us.sentry.io/api/42/integration/otlp",
      envelope: "https://o1.ingest.us.sentry.io/api/42/envelope/",
    });
  });

  test("writes a span that lasts across invocations with its kept id, start and op", () => {
    const span = otlpSpan({ traceId: "t".repeat(32), spanId: "s".repeat(16), parentSpanId: "p".repeat(16), name: "extract", op: "workflow.phase", startMs: 1000, endMs: 2500, failed: true, attributes: { "app.detector": "x-post", skip: undefined } });
    expect(span).toMatchObject({ name: "extract", startTimeUnixNano: "1000000000", endTimeUnixNano: "2500000000", status: { code: 2 } });
    expect(span.attributes.map((a) => a.key)).toEqual(["sentry.op", "sentry.description", "app.detector"]);
  });

  test("an error event carries the exception, its stack, the tags and the trace", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at inner (src/workflow.ts:10:5)\n    at outer (src/index.ts:20:3)";
    const [header, item, event] = errorEnvelope(err, { "video.id": "abc" }, { traceId: "t".repeat(32), spanId: "s".repeat(16) } as never, 0).trim().split("\n").map((l) => JSON.parse(l));
    expect(header.event_id).toBe(event.event_id);
    expect(item).toEqual({ type: "event" });
    expect(event.exception.values[0]).toMatchObject({ type: "Error", value: "boom" });
    expect(event.exception.values[0].stacktrace.frames.map((f: { function: string }) => f.function)).toEqual(["outer", "inner"]);
    expect(event.tags).toEqual({ "video.id": "abc" });
    expect(event.contexts.trace).toEqual({ trace_id: "t".repeat(32), span_id: "s".repeat(16) });
  });

  test("reads stack lines without a function name", () => {
    expect(stackFrames("Error\n    at src/index.ts:1:2")).toEqual([{ function: "?", filename: "src/index.ts", lineno: 1, colno: 2, in_app: true }]);
  });
});

test("retention expires temporary images and preserves mention images", () => {
  const now = Date.now();
  const old = new Date(now - 3 * 86400000);
  expect(isExpiredFrame("videos/id/f640/390.jpg", old, now)).toBe(true);
  expect(isExpiredFrame("videos/id/f640/390.jpg", new Date(old.getTime() + 1), now)).toBe(false);
  expect(isExpiredFrame("videos/id/f1920/390.jpg", old, now)).toBe(true);
  expect(isExpiredFrame("videos/id/f1920/390.jpg", old, now, new Set(["videos/id/f1920/390.jpg"]))).toBe(false);
  expect(isExpiredFrame("videos/id/manifest.json", old, now)).toBe(false);
});
