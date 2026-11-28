import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { embed, embedRequests, findQuote, hedge, readPosts, retryDelayMs, runModel } from "../src/ai";
import { DETECTORS } from "../src/config";
import { Schema } from "effect";
import type { Env, Json, ModelInputs } from "../src/env";
import { runApp, type App } from "../src/runtime";
import { ai, env as bindings, textsAsked } from "./bindings";

const run = <A>(env: Env, effect: Effect.Effect<A, unknown, App>) => runApp(env, effect);

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

  const env = bindings({
    AI: ai((_model, inputs) => {
      const text = textsAsked(inputs);
      sizes.push(text.length);

      if (text.length > 2) throw new Error("8007: Max context reached 68424 tokens but model supports only 60000");

      return { data: text.map((t) => [Number(t)]) };
    }),
  });

  expect(await run(env, embed(["1", "2", "3", "4", "5"]))).toEqual([[1], [2], [3], [4], [5]]);
  expect(sizes).toEqual([5, 2, 3, 1, 2]);
});

test("an embed error that is not the token limit is not split", async () => {
  let calls = 0;

  const env = bindings({
    AI: ai(() => {
      calls++;
      throw new Error("4007: bad input");
    }),
  });

  await expect(run(env, embed(["1", "2"]))).rejects.toThrow("4007");
  expect(calls).toBe(1);
});

const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/** A call that runs `fn` each time the hedge starts it. */
const calling = <T>(fn: () => Promise<T>) => Effect.suspend(() => Effect.tryPromise({ try: fn, catch: (err) => err }));
const hedged = <T>(delayMs: number, fn: () => Promise<T>) => run(bindings(), hedge("model", delayMs, calling(fn)));

test("a call still running at the hedge delay is sent again, and the first answer wins", async () => {
  let calls = 0;
  const answer = await hedged(10, () => (++calls === 1 ? after(200, "stuck") : after(5, "fresh")));
  expect(answer).toBe("fresh");
  expect(calls).toBe(2);
});

test("a fast call is sent once", async () => {
  let calls = 0;
  expect(await hedged(50, () => (calls++, after(1, "ok")))).toBe("ok");
  await after(80, null);
  expect(calls).toBe(1);
});

test("a call that fails before the hedge delay fails without a second call", async () => {
  let calls = 0;
  // A first failure can take tens of milliseconds to reach the hedge while bun maps its stack, so the delay is long.
  await expect(hedged(300, () => (calls++, Promise.reject(new Error("bad input"))))).rejects.toThrow("bad input");
  await after(350, null);
  expect(calls).toBe(1);
});

test("a second call that fails while the first is stuck fails the hedge", async () => {
  let calls = 0;
  const call = () => (++calls === 1 ? after(500, "stuck") : Promise.reject(new Error("capacity")));
  await expect(hedged(10, call)).rejects.toThrow("capacity");
});

test("two stuck calls fail at 4 times the hedge delay", async () => {
  const startedAt = Date.now();
  await expect(hedged(10, () => after(500, "stuck"))).rejects.toThrow("no answer in 40 ms");
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

test("the call that loses a hedge is interrupted", async () => {
  let interrupted = false;
  let calls = 0;

  const call = Effect.suspend(() =>
    ++calls === 1 ? Effect.promise(() => after(100, "stuck")).pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))) : Effect.promise(() => after(1, "fresh")),
  );

  expect(await run(bindings(), hedge("model", 5, call))).toBe("fresh");
  expect(interrupted).toBe(true);
});

test("an interrupted model call is not sent again", async () => {
  let calls = 0;
  const env = bindings({ AI: ai(() => (calls++, Promise.reject(new Error("error 3021")))) });
  await run(env, Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(runModel("model", {}, 3));
    yield* Effect.sleep(20);
    yield* Fiber.interrupt(fiber);
  }));
  await after(50, null);
  expect(calls).toBe(1);
});

const readerAsked = Schema.decodeUnknownSync(Schema.Struct({ max_tokens: Schema.Number }));
const quoteAsked = (inputs: ModelInputs) => Schema.decodeUnknownSync(Schema.Struct({ fields: Schema.Struct({ quote: Schema.Struct({ instructions: Schema.String }) }) }))(inputs).fields.quote.instructions;

describe("reading a frame", () => {
  const jpeg = new ArrayBuffer(1);
  const frame = { videoId: "v", second: 1, size: "f1920" } as const;

  const read = (page: number, chat: number, source = "X") => {
    let reads = 0;

    const env = bindings({
      AI: ai((model, inputs): Json => {
        if (model.includes("flash")) return { answers: { page: { noul: page }, chat: { noul: chat } } };
        reads++;

        return { choices: [{ message: { content: readerAsked(inputs).max_tokens === 5 ? source : "@alice | Alice | a real post" } }] };
      }),
    });

    return { lines: run(env, readPosts(DETECTORS[0], jpeg, frame)), reads: () => reads };
  };

  test("a page with an X post and no chat is read", async () => {
    const result = read(0.72, 0.35);
    expect(await result.lines).toEqual([{ handle: "@alice", displayName: "Alice", text: "a real post" }]);
    expect(result.reads()).toBe(2);
  });

  for (const source of ["CHAT", "OTHER", "chat."]) {
    test(`text from a frame answered ${source} is dropped`, async () => {
      expect(await read(0.87, 0.05, source).lines).toEqual([]);
    });
  }

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

    const env = bindings({
      AI: ai((_model, inputs) => {
        questions.push(quoteAsked(inputs));

        return { answers: { quote: { span } } };
      }),
    });

    return { env, questions };
  };

  const readTranscript = "okay so claude code now reads agents md files which is great for everyone here";
  const ownWordsTranscript = "also of note is that the latest update will use your agent file if you have one";

  test("post words in the transcript ask for the reading", async () => {
    const { env, questions } = ask([8, 40]);
    const question = detector.quoteInstructions(post);
    expect(await run(env, findQuote(detector, post, readTranscript))).toEqual({ question, answer: readTranscript.slice(8, 40), span: [8, 40], how: "read" });
    expect(questions).toEqual([question]);
  });

  test("no post words in the transcript ask for the same point in other words", async () => {
    const { env, questions } = ask([0, 40]);
    const question = detector.ownWordsInstructions(post);
    expect(await run(env, findQuote(detector, post, ownWordsTranscript))).toEqual({ question, answer: ownWordsTranscript.slice(0, 40), span: [0, 40], how: "own_words" });
    expect(questions).toEqual([question]);
  });

  test("a one-word answer falls back to the post words in the transcript", async () => {
    const { env } = ask([8, 14]);
    const search = await run(env, findQuote(detector, post, readTranscript));
    expect(search.how).toBe("word_run");
    expect(search.answer).toBe("claude");
    expect(readTranscript.slice(...search.span!)).toContain("claude code now");
  });

  test("no answer and no post words is no quote", async () => {
    const { env } = ask(null);
    const search = await run(env, findQuote(detector, post, ownWordsTranscript));
    expect(search).toMatchObject({ answer: null, span: null, how: null });
  });
});
