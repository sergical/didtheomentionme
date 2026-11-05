import { expect, test } from "bun:test";
import { embedRequests, hedge } from "../src/ai";

test("a long post that would pad a request past the limit starts a new one", () => {
  const short = "theo: short post";
  const long = `theo: ${"x".repeat(6000)}`;
  const requests = embedRequests([...Array(49).fill(short), long]);
  expect(requests.flat()).toEqual([...Array(49).fill(short), long]);
  for (const request of requests) {
    const longest = Math.max(...request.map((text) => Math.ceil(text.length / 3)));
    expect(request.length * longest).toBeLessThanOrEqual(60_000);
  }
});

test("short posts share one embed request", () => {
  expect(embedRequests(Array(50).fill("theo: short post"))).toHaveLength(1);
});

const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

test("a call still running at the hedge delay is sent again, and the first answer wins", async () => {
  let calls = 0;
  const answer = await hedge("model", 10, () => (++calls === 1 ? after(200, "stuck") : after(5, "fresh")));
  expect(answer).toBe("fresh");
  expect(calls).toBe(2);
});

test("a fast call is sent once", async () => {
  let calls = 0;
  expect(await hedge("model", 50, () => (calls++, after(1, "ok")))).toBe("ok");
  await after(80, null);
  expect(calls).toBe(1);
});

test("a call that fails before the hedge delay fails without a second call", async () => {
  let calls = 0;
  await expect(hedge("model", 50, () => (calls++, Promise.reject(new Error("bad input"))))).rejects.toThrow("bad input");
  await after(80, null);
  expect(calls).toBe(1);
});

test("a second call that fails while the first is stuck fails the hedge", async () => {
  let calls = 0;
  const call = () => (++calls === 1 ? after(500, "stuck") : Promise.reject(new Error("capacity")));
  await expect(hedge("model", 10, call)).rejects.toThrow("capacity");
});

test("two stuck calls fail at 4 times the hedge delay", async () => {
  const startedAt = Date.now();
  await expect(hedge("model", 10, () => after(500, "stuck"))).rejects.toThrow("no answer in 40 ms");
  expect(Date.now() - startedAt).toBeLessThan(200);
});
