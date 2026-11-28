import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { runApp } from "../src/runtime";
import { env } from "./bindings";

afterEach(() => {
  mock.restore();
});

test("an Effect run sets no timer, because Workers can drop the timers of a finished request", async () => {
  const timeouts = spyOn(globalThis, "setTimeout");
  const immediates = spyOn(globalThis, "setImmediate");

  const result = await runApp(env(), Effect.gen(function* () {
    // Yields to the scheduler several times, as a long Effect does.
    for (let i = 0; i < 5; i++) yield* Effect.yieldNow;

    return "done";
  }));

  expect([result, timeouts.mock.calls.length, immediates.mock.calls.length]).toEqual(["done", 0, 0]);
});
