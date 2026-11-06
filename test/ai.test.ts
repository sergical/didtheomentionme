import { describe, expect, test } from "bun:test";
import { embed, embedRequests, findQuote, hedge, readPosts, retryDelayMs, runModel } from "../src/ai";
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
  const frame = { videoId: "v", second: 1, size: "f1920" } as const;
  const read = (page: number, chat: number) => {
    let reads = 0;
    const env = {
      AI: {
        run: async (model: string) => {
          if (model.includes("flash")) return { answers: { page: { noul: page }, chat: { noul: chat } } };
          reads++;
          return { choices: [{ message: { content: "@alice | Alice | a real post" } }] };
        },
      },
    } as unknown as Env;
    return { lines: readPosts(env, DETECTORS[0], jpeg, frame), reads: () => reads };
  };

  test("a page with an X post and no chat is read", async () => {
    const result = read(0.72, 0.35);
    expect(await result.lines).toEqual([{ handle: "@alice", displayName: "Alice", text: "a real post" }]);
    expect(result.reads()).toBe(1);
  });

  test("a page that is not X is not read", async () => {
    const result = read(0.64, 0.1);
    expect(await result.lines).toEqual([]);
    expect(result.reads()).toBe(0);
  });

  test("a stream chat is not read", async () => {
    const result = read(0.9, 0.5);
    expect(await result.lines).toEqual([]);
    expect(result.reads()).toBe(0);
  });
});

describe("findQuote", () => {
  const detector = DETECTORS[0];
  const post = { handle: "@trq212", displayName: "Thariq", text: "Claude Code now reads AGENTS.md files" };
  const ask = (span: [number, number] | null) => {
    const questions: string[] = [];
    const env = {
      AI: {
        run: async (_model: string, { fields }: { fields: { quote: { instructions: string } } }) => {
          questions.push(fields.quote.instructions);
          return { answers: { quote: { span } } };
        },
      },
    } as unknown as Env;
    return { env, questions };
  };
  const readTranscript = "okay so claude code now reads agents md files which is great for everyone here";
  const ownWordsTranscript = "also of note is that the latest update will use your agent file if you have one";

  test("post words in the transcript ask for the reading", async () => {
    const { env, questions } = ask([8, 40]);
    const question = detector.quoteInstructions(post);
    expect(await findQuote(env, detector, post, readTranscript)).toEqual({ question, answer: readTranscript.slice(8, 40), span: [8, 40], how: "read" });
    expect(questions).toEqual([question]);
  });

  test("no post words in the transcript ask for the same point in other words", async () => {
    const { env, questions } = ask([0, 40]);
    const question = detector.ownWordsInstructions(post);
    expect(await findQuote(env, detector, post, ownWordsTranscript)).toEqual({ question, answer: ownWordsTranscript.slice(0, 40), span: [0, 40], how: "own_words" });
    expect(questions).toEqual([question]);
  });

  test("a one-word answer falls back to the post words in the transcript", async () => {
    const { env } = ask([8, 14]);
    const search = await findQuote(env, detector, post, readTranscript);
    expect(search.how).toBe("word_run");
    expect(search.answer).toBe("claude");
    expect(readTranscript.slice(...search.span!)).toContain("claude code now");
  });

  test("no answer and no post words is no quote", async () => {
    const { env } = ask(null);
    const search = await findQuote(env, detector, post, ownWordsTranscript);
    expect(search).toMatchObject({ answer: null, span: null, how: null });
  });
});
