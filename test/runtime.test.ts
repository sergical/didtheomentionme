import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { runApp } from "../src/runtime";
import { env } from "./bindings";

const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;

/** Puts `timer` in place of a global timer function. */
const setGlobal = (name: "setTimeout" | "setImmediate", timer: typeof setTimeout | typeof setImmediate | (() => void)) =>
  Object.defineProperty(globalThis, name, { value: timer, configurable: true, writable: true });

afterEach(() => {
  setGlobal("setTimeout", realSetTimeout);
  setGlobal("setImmediate", realSetImmediate);
});

test("an Effect run needs no timer, because Workers can drop the timers of a finished request", async () => {
  // Timers set now never fire, like the timers of a request that has ended.
  setGlobal("setTimeout", () => {});
  setGlobal("setImmediate", () => {});

  const run = runApp(env(), Effect.gen(function* () {
    // Yields to the scheduler several times, as a long Effect does.
    for (let i = 0; i < 5; i++) yield* Effect.yieldNow;

    return "done";
  }));

  const timeout = new Promise((resolve) => realSetTimeout(() => resolve("hung"), 500));
  expect(await Promise.race([run, timeout])).toBe("done");
});
