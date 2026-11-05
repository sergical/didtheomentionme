import { describe, expect, test } from "bun:test";
import { embed, embedRequests, hedge, readPosts, retryDelayMs, runModel } from "../src/ai";
import { DETECTORS } from "../src/config";
import type { Env } from "../src/env";

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

test("a request over the token limit is split, and the vectors keep the order of the texts", async () => {
  const sizes: number[] = [];
  const env = {
    AI: {
      run: async (_model: string, { text }: { text: string[] }) => {
        sizes.push(text.length);
        if (text.length > 2) throw new Error("8007: Max context reached 68424 tokens but model supports only 60000");
        return { data: text.map((t) => [Number(t)]) };
      },
    },
  } as unknown as Env;
  expect(await embed(env, ["1", "2", "3", "4", "5"])).toEqual([[1], [2], [3], [4], [5]]);
  expect(sizes).toEqual([5, 2, 3, 1, 2]);
});

test("an embed error that is not the token limit is not split", async () => {
  let calls = 0;
  const env = {
    AI: {
      run: async () => {
        calls++;
        throw new Error("4007: bad input");
      },
    },
  } as unknown as Env;
  await expect(embed(env, ["1", "2"])).rejects.toThrow("4007");
  expect(calls).toBe(1);
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

test("the per-minute rate limit waits longer than a server error", () => {
  const rateLimit = new Error("AiError: 3021: rate limiting: inference request per min rate reached");
  expect(retryDelayMs(rateLimit, 0)).toBeGreaterThanOrEqual(10_000);
  expect(retryDelayMs(Object.assign(new Error("x"), { status: 503 }), 0)).toBeLessThan(2000);
});

test("a bad request is not retried", () => {
  expect(retryDelayMs(new Error("AiError: 5006: invalid input"), 0)).toBeNull();
  expect(retryDelayMs(Object.assign(new Error("x"), { status: 400 }), 0)).toBeNull();
});

test("a settled hedge tells the call that lost to stop retrying", async () => {
  let loser = () => false;
  let calls = 0;
  await hedge("model", 5, (abandoned) => {
    if (++calls === 1) {
      loser = abandoned;
      return after(100, "stuck");
    }
    return after(1, "fresh");
  });
  expect(loser()).toBe(true);
});

test("an abandoned model call is not sent again", async () => {
  let calls = 0;
  const env = { AI: { run: async () => (calls++, Promise.reject(new Error("error 3021"))) } } as unknown as Env;
  await expect(runModel(env, "model", {}, 3, () => true)).rejects.toThrow("3021");
  expect(calls).toBe(1);
});

describe("reading a frame", () => {
  const jpeg = new ArrayBuffer(1);
  const frame = { videoId: "v", second: 1, size: "f1280" } as const;
  const read = (count: number, chat: number) => {
    let asked = 0;
    const content = Array.from({ length: count }, (_, i) => `@user${i} | User | message ${i}`).join("\n");
    const env = {
      AI: { run: async (model: string) => (model.includes("flash") ? (asked++, { answers: { frame: { noul: chat } } }) : { choices: [{ message: { content } }] }) },
    } as unknown as Env;
    return { lines: readPosts(env, DETECTORS[0], jpeg, frame), asked: () => asked };
  };

  test("a frame with few lines is not checked for chat", async () => {
    const result = read(7, 0.9);
    expect(await result.lines).toHaveLength(7);
    expect(result.asked()).toBe(0);
  });

  test("a frame with many lines that shows a chat has no posts", async () => {
    expect(await read(8, 0.9).lines).toEqual([]);
  });

  test("a frame with many lines that shows no chat keeps its posts", async () => {
    expect(await read(9, 0.06).lines).toHaveLength(9);
  });
});
