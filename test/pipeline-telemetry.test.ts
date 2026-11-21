import { describe, expect, test } from "bun:test";
import { VIDEO, runVideo } from "./fixture";
import { DSN, captureOtlp, type Capture, type SentSpan } from "./harness";

const op = (s: SentSpan) => String(s.attributes["sentry.op"]);
const named = (sent: Capture, name: string) => sent.spans.filter((s) => s.name === name);

const sent = captureOtlp();
await runVideo({ dsn: DSN });
sent.restore();

describe("a video run sends one trace to Sentry", () => {
  test("with one root span for the run, which carries the outcome and counts", () => {
    expect(new Set(sent.spans.map((s) => s.traceId)).size).toBe(1);
    const roots = sent.spans.filter((s) => !s.parentSpanId);
    expect(roots.map((s) => s.name)).toEqual([`video ${VIDEO}`]);
    expect(roots[0].attributes).toMatchObject({ "video.outcome": "done", "video.mentions": 1, "video.read_aloud": 1, "sentry.op": "workflow.run" });
  });

  test("in which every parent span is sent", () => {
    const ids = new Set(sent.spans.map((s) => s.spanId));
    expect(sent.spans.filter((s) => s.parentSpanId && !ids.has(s.parentSpanId)).map((s) => s.name)).toEqual([]);
  });

  test("with each phase under the run, and each step under its phase", () => {
    const root = sent.spans.find((s) => !s.parentSpanId)!;
    const phases = sent.spans.filter((s) => op(s) === "workflow.phase");
    expect(phases.map((s) => s.name).sort()).toEqual(["detect", "extract", "read", "store", "transcribe"]);
    for (const phase of phases) expect(phase.parentSpanId).toBe(root.spanId);
    const store = phases.find((s) => s.name === "store")!;
    expect(named(sent, "store-db")[0].parentSpanId).toBe(store.spanId);
    expect(named(sent, "mark-final")[0].parentSpanId).toBe(root.spanId);
    expect(sent.spans.filter((s) => s.name.startsWith("phase:"))).toEqual([]);
  });

  test("with each query's whole SQL as its description, so Sentry tells different queries apart", () => {
    const queries = sent.spans.filter((s) => s.attributes["sentry.op"] === "db.query");
    for (const query of queries) expect(query.attributes["sentry.description"]).toBe(query.attributes["db.query.text"]);
    const updates = queries.filter((s) => s.name === "UPDATE videos").map((s) => s.attributes["sentry.description"]);
    expect(new Set(updates).size).toBeGreaterThan(1);
  });

  test("with storage spans named as Sentry's SDKs name them", () => {
    expect(sent.spans.filter((s) => op(s) === "object.get").every((s) => s.name === "r2_get")).toBe(true);
    expect(named(sent, "D1 batch")).toHaveLength(1);
    expect(named(sent, "UPDATE videos").length).toBeGreaterThan(0);
  });

  test("with model spans that carry the model, tokens, cost and frame", () => {
    const reader = sent.spans.find((s) => s.attributes["gen_ai.request.model"] === "@cf/qwen/qwen3.8-27b")!;
    expect(reader.attributes).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10, "sentry.description": reader.name });
    expect(reader.attributes["gen_ai.cost.total_tokens"] as number).toBeCloseTo((100 * 0.45 + 10 * 3.2) / 1e6, 12);
    expect(String(reader.attributes["app.frame.url"])).toContain(`/frame/${VIDEO}/`);
    expect(String(reader.attributes["gen_ai.input.messages"])).not.toContain("base64");
    const embedding = sent.spans.find((s) => s.attributes["gen_ai.request.model"] === "@cf/baai/bge-m3")!;
    expect(embedding.attributes["app.tokens_estimated"]).toBe(true);
  });

  test("with logs that keep their attributes and trace", () => {
    const read = sent.logs.find((l) => l.body.includes("was read aloud"));
    expect(read?.attributes).toMatchObject({ "video.id": VIDEO });
    expect(read?.traceId).toBe(sent.spans[0].traceId);
    expect(sent.events).toEqual([]);
  });
});

test("a failed run makes one Issue, linked to its trace, and a failed root span", async () => {
  const failed = captureOtlp();
  await runVideo({ dsn: DSN, job: { state: "error", stage: "metadata", error: "This video is unavailable", manifest: null } });
  failed.restore();
  expect(failed.events.map((e) => [e.type, e.value])).toEqual([["NonRetryableError", "extract failed at metadata: This video is unavailable"]]);
  expect(failed.events[0].traceId).toBe(failed.spans[0].traceId);
  expect(failed.events[0].tags).toMatchObject({ "video.id": VIDEO });
  const root = failed.spans.find((s) => !s.parentSpanId)!;
  expect(root).toMatchObject({ failed: true });
  expect(root.attributes["video.outcome"]).toBe("error");
});

test("a run whose first step fails still ends its run, with an Issue and a failed root span", async () => {
  const failed = captureOtlp();
  const result = await runVideo({ dsn: DSN, failProcessing: true, instanceId: `${VIDEO}_first_step` });
  failed.restore();
  expect(result.completed).toBe(false);
  expect(result.db.query("SELECT outcome, reason IS NOT NULL AS reason FROM video_runs").all()).toEqual([{ outcome: "error", reason: 1 }]);
  expect(result.db.query("SELECT status FROM videos").all()).toEqual([{ status: "error" }]);
  expect(failed.events.map((e) => e.value)).toEqual(["D1 unavailable"]);
  expect(failed.spans.find((s) => !s.parentSpanId)).toMatchObject({ failed: true });
});
