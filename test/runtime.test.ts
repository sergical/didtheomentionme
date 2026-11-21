import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Env } from "../src/env";
import { runApp } from "../src/runtime";

const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setImmediate = realSetImmediate;
});

test("an Effect run needs no timer, because Workers can drop the timers of a finished request", async () => {
  // Timers set now never fire, like the timers of a request that has ended.
  globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
  globalThis.setImmediate = (() => 0) as unknown as typeof setImmediate;
  const run = runApp({} as Env, Effect.gen(function* () {
    // Yields to the scheduler several times, as a long Effect does.
    for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
    return "done";
  }));
  const timeout = new Promise((resolve) => realSetTimeout(() => resolve("hung"), 500));
  expect(await Promise.race([run, timeout])).toBe("done");
});
