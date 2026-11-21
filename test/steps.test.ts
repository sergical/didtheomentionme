import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { Env } from "../src/env";
import { Steps } from "../src/steps";
import { DSN, captureOtlp, engine, settle } from "./harness";

const config = { retries: { limit: 1, delay: "1 second", backoff: "constant" } } as const;

test("each phase and the run are one span, sent once, across restarts at an event wait and after a phase's last step", async () => {
  const sent = captureOtlp();
  const env = { SENTRY_DSN: DSN } as unknown as Env;
  const step = engine(["phase:transcribe:end"]);
  const run = async () => {
    const steps = await Steps.start(env, step as never, "replay-instance");
    const startMs = await steps.do("mark-processing", config, Effect.sync(() => Date.now()));
    await steps.phase("extract", async (s) => {
      await s.do("extract-start", config, Effect.succeed(0));
      await s.waitForEvent("extract-done", { type: "extract-done" });
      await s.do("extract-check", config, Effect.succeed(1));
    });
    await steps.phase("transcribe", async (s) => {
      await s.do("transcribe-0", config, Effect.succeed(1));
      await s.do("transcribe-1", config, Effect.succeed(2));
    });
    await steps.do("mark-final", config, steps.recordRun("video", startMs, false, {}));
  };

  // Suspends at the event, then before the transcribe phase's end step, then finishes.
  // Each step now waits for its telemetry, so an invocation needs time to reach its suspension point.
  for (let restart = 0; restart < 2; restart++) {
    void run();
    await settle(500);
  }
  await run();
  sent.restore();

  const byName = (name: string) => sent.spans.filter((s) => s.name === name);
  for (const name of ["video", "extract", "transcribe", "extract-done", "mark-processing", "extract-start", "extract-check", "transcribe-0", "transcribe-1", "mark-final"]) {
    expect(byName(name)).toHaveLength(1);
  }
  const [root] = byName("video");
  const [extract] = byName("extract");
  const [transcribe] = byName("transcribe");
  expect(root.parentSpanId).toBeUndefined();
  expect([extract, transcribe, byName("mark-processing")[0], byName("mark-final")[0]].map((s) => s.parentSpanId)).toEqual(Array(4).fill(root.spanId));
  expect(["extract-start", "extract-check", "extract-done"].map((n) => byName(n)[0].parentSpanId)).toEqual(Array(3).fill(extract.spanId));
  expect(["transcribe-0", "transcribe-1"].map((n) => byName(n)[0].parentSpanId)).toEqual(Array(2).fill(transcribe.spanId));
  expect(byName("extract-done")[0].attributes["sentry.op"]).toBe("workflow.wait");
  expect(sent.spans.filter((s) => s.name.startsWith("phase:"))).toEqual([]);
  expect(new Set(sent.spans.map((s) => s.traceId)).size).toBe(1);
});

test("a step ends only after Sentry has its spans and logs", async () => {
  const sent = captureOtlp({ latencyMs: 50 });
  const steps = await Steps.start({ SENTRY_DSN: DSN } as unknown as Env, engine() as never, "flush-instance");
  await steps.do("store-db", config, Effect.logInfo("Stored 1 mentions"));
  // No waiting: Workflows may end the invocation as soon as the step returns.
  sent.restore();
  expect(sent.spans.map((s) => s.name)).toEqual(["store-db"]);
  expect(sent.logs.map((l) => l.body)).toEqual(["Stored 1 mentions"]);
});
