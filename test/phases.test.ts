import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as Sentry from "@sentry/cloudflare";
import { embed } from "../src/ai";
import type { Env } from "../src/env";
import { phase, sentryOptions, waitForEvent, type PhaseStep } from "../src/telemetry";

const require = createRequire(import.meta.resolve("@sentry/cloudflare"));
const { instrumentWorkersAiClient } = require("@sentry/server-utils");

type Span = {
  name: string;
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  is_segment: boolean;
  start_timestamp: number;
  attributes: Record<string, { value: unknown }>;
};

function capture() {
  const sent: Span[] = [];
  const options = {
    ...sentryOptions({} as Env),
    dsn: "https://public@example.com/1",
    transport: () => ({
      send: async (envelope: [unknown, [{ type: string }, { items: Span[] }][]]) => {
        for (const [header, body] of envelope[1]) if (header.type === "span") sent.push(...body.items);
        return {};
      },
      flush: async () => true,
    }),
  };
  const named = (name: string) => sent.filter((span) => span.name === name);
  const attribute = (span: Span | undefined, key: string) => span?.attributes[key]?.value;
  return { sent, options, named, attribute };
}

/**
 * Runs finished steps from the cache, like the Workflows engine on replay. It suspends at an event that has not
 * come, and once before each step in `evictAt`, like a Worker evicted between two steps.
 */
function engine(evictAt: string[] = []) {
  const cache = new Map<string, unknown>();
  const evict = new Set(evictAt);
  return {
    async do(name: string, config: object, callback: (ctx: unknown) => Promise<unknown>) {
      if (evict.delete(name)) return new Promise(() => {});
      if (!cache.has(name)) cache.set(name, await callback({ attempt: 1, config, step: { name, count: 1 } }));
      return cache.get(name);
    },
    waitForEvent: (name: string) => (cache.has(name) ? Promise.resolve() : (cache.set(name, true), new Promise<void>(() => {}))),
  };
}

test("workflow steps nest under one phase span each, sent once, across restarts at an event wait and after a phase's last step", async () => {
  const { sent, options, named, attribute } = capture();
  const config = { retries: { limit: 1, delay: "1 second", backoff: "constant" } } as const;
  class Fixture {
    async run(_event: unknown, step: PhaseStep) {
      await phase("extract", step, async (step) => {
        await step.do("extract-start", config, async () => 0);
        await waitForEvent(step, "extract-done", { type: "extract-done" });
        await step.do("extract-check", config, async () => 1);
      });
      await phase("transcribe", step, async (step) => {
        await step.do("transcribe-0", config, async () => 1);
        await step.do("transcribe-1", config, async () => 2);
      });
      await phase("store", step, (step) => step.do("store-db", config, async () => 3));
    }
  }
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  const Workflow = Sentry.instrumentWorkflowWithSentry(() => options, Fixture as never) as unknown as new (...args: unknown[]) => Fixture;
  const step = engine(["phase:transcribe:end"]);
  const event = { instanceId: "replay-instance", payload: {}, timestamp: new Date() };

  for (let restart = 0; restart < 2; restart++) {
    void new Workflow(ctx, {}).run(event, step as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Workflow(ctx, {}).run(event, step as never);
  await new Workflow(ctx, {}).run(event, step as never);
  await Promise.all(pending);

  const phases = sent.filter((span) => attribute(span, "sentry.op") === "workflow.phase");
  expect(phases.map((span) => span.name)).toEqual(["extract", "transcribe", "store"]);
  const [extract, transcribe, store] = phases;
  for (const [parent, names] of [[extract, ["extract-start", "extract-check"]], [transcribe, ["transcribe-0", "transcribe-1"]]] as const) {
    for (const name of names) {
      expect(named(name)).toHaveLength(1);
      expect(named(name)[0]).toMatchObject({ parent_span_id: parent.span_id, is_segment: true });
    }
  }
  expect(extract.start_timestamp).toBeLessThanOrEqual(named("extract-start")[0].start_timestamp);
  expect(named("extract-done")).toHaveLength(1);
  expect(named("extract-done")[0]).toMatchObject({ parent_span_id: extract.span_id });
  expect(attribute(named("extract-done")[0], "sentry.op")).toBe("workflow.wait");
  expect(phases.map((span) => span.parent_span_id)).toEqual([undefined, undefined, undefined]);
  expect(named("store-db")[0].parent_span_id).toBe(store.span_id);
  expect(sent.filter((span) => span.name.startsWith("phase:"))).toHaveLength(0);
  expect(new Set(sent.map((span) => span.trace_id)).size).toBe(1);
});

test("bge-m3 embeddings spans carry estimated input tokens and a cost", async () => {
  const { options, named, attribute } = capture();
  const { initAndBind } = require("@sentry/core");
  const { ServerRuntimeClient } = require("@sentry/core/server");
  const client = initAndBind(ServerRuntimeClient, { ...options, stackParser: () => [] });
  const AI = instrumentWorkersAiClient({ run: async () => ({ shape: [2, 3], data: [[0, 0, 1], [1, 0, 0]] }) });
  const texts = ["@theo: hello world", "@t3dotgg: a longer post about ".repeat(20)];

  await Sentry.startSpan({ name: "store-vectors" }, () => embed({ AI } as unknown as Env, texts));
  await client.flush();

  const [span] = named("embeddings @cf/baai/bge-m3");
  const tokens = Math.ceil(texts[0].length / 4) + Math.ceil(texts[1].length / 4);
  expect(attribute(span, "gen_ai.usage.input_tokens")).toBe(tokens);
  expect(attribute(span, "app.tokens_estimated")).toBe(true);
  expect(attribute(span, "gen_ai.cost.total_tokens") as number).toBeCloseTo((tokens * 0.012) / 1e6, 12);
  await client.close();
});
