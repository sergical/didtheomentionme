import { expect, test } from "bun:test";
import type { Env } from "../src/env";
import { DSN, captureOtlp, settle } from "./harness";
import "./fixture";

const worker = (await import("../src/index")).default;

test("an error that escapes a request makes an Issue in the request's trace", async () => {
  const sent = captureOtlp();
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const env = { SENTRY_DSN: DSN, DB: { prepare: () => { throw new Error("D1 unavailable"); } } } as unknown as Env;

  await expect(worker.fetch(new Request("https://didtheomention.me/explore"), env, ctx)).rejects.toThrow("D1 unavailable");
  await Promise.all(pending);
  await settle(1500);
  sent.restore();

  const [request] = sent.spans.filter((s) => s.name === "GET /explore");
  expect(request).toMatchObject({ failed: true });
  expect(sent.events.map((e) => [e.value, e.traceId, e.tags["http.route"]])).toEqual([["D1 unavailable", request.traceId, "/explore"]]);
});
