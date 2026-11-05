import { expect, test } from "bun:test";
import { embedRequests } from "../src/ai";

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
