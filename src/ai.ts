import { Effect, Fiber, Option } from "effect";
import type { Detector, Post } from "./config";
import { parseReaderLines, quoteSpan, wordRunSpan, wordsFromSegments, type ReaderLine, type Word } from "./pipeline";
import { Bindings, annotate, span } from "./runtime";
import { OPERATIONS, WHISPER, errorMessage, frameAttributes, redactImages, usageAttributes, whisperCostAttributes, type Attributes, type FrameReference } from "./telemetry";

// The AI binding types in workers-types do not list these models.
type AnyRun = { run(model: string, inputs: unknown): Promise<any> };

const FLASH = "@cf/cloudflare/clef-flash";
const CLEF = "@cf/cloudflare/clef";
const CLAIRIC = "@cf/cloudflare/clairic";
const READER = "@cf/qwen/qwen3.8-27b";
const EMBED = "@cf/baai/bge-m3";

/** On 142 sampled frames half answered in 3.5 s, 7 took over 20 s and the slowest 37 s. Each of those 7 costs one extra call. */
const READ_HEDGE_MS = 20_000;

/**
 * The wait before the next attempt, or null when a retry cannot help. Error 3021 is the per-minute limit on
 * inference requests, so it waits for the minute to move on, not for a second.
 */
export function retryDelayMs(err: unknown, attempt: number): number | null {
  const status = (err as { status?: number })?.status;
  const message = errorMessage(err);
  const rateLimited = status === 429 || /\b(429|3021)\b|rate limit/i.test(message);
  const retryable = status !== undefined ? rateLimited || status >= 500 : rateLimited || /\b5\d\d\b|capacity|overloaded|timed? ?out|temporar|internal/i.test(message);

  if (!retryable) return null;

  return (rateLimited ? 10_000 : 1000) * 2 ** attempt + Math.random() * 500;
}

/** One binding call, retried while a retry can help. An interrupted call, for example a hedge's loser, stops retrying. */
export const runModel = (model: string, inputs: unknown, attempts = 3): Effect.Effect<any, unknown, Bindings> =>
  Effect.gen(function* () {
    const env = yield* Bindings;

    for (let attempt = 0; ; attempt++) {
      const result = yield* Effect.result(Effect.tryPromise({ try: () => (env.AI as unknown as AnyRun).run(model, inputs), catch: (err) => err }));

      if (result._tag === "Success") {
        if (attempt) yield* annotate({ "app.retries": attempt });

        return result.success;
      }

      const err = result.failure;
      const delay = retryDelayMs(err, attempt);

      if (attempt >= attempts - 1 || delay === null) return yield* Effect.fail(err);
      yield* Effect.logWarning(`${model} failed, retry ${attempt + 1} of ${attempts - 1}`).pipe(
        Effect.annotateLogs({ "gen_ai.request.model": model, error: errorMessage(err).slice(0, 300) }),
      );
      yield* Effect.sleep(delay);
    }
  });

/**
 * A gen_ai span for one model call, in the names Sentry's AI Agents views read. Its attributes are set when the
 * call starts and ends, so nothing rewrites the span before it is sent.
 */
export const modelSpan = (model: string, attributes: Attributes) =>
  span(`${OPERATIONS[model] ?? "run"} ${model}`, `gen_ai.${OPERATIONS[model] ?? "run"}`, {
    "gen_ai.operation.name": OPERATIONS[model] ?? "run",
    "gen_ai.provider.name": "cloudflare.workers_ai",
    "gen_ai.request.model": model,
    ...attributes,
  });

/** Usage from the answer, or an estimate of 4 characters per token when the model reports none. */
const recordUsage = (model: string, result: any, estimate?: number) => {
  const input = result?.usage?.prompt_tokens ?? result?.usage?.input_tokens;
  const output = result?.usage?.completion_tokens ?? result?.usage?.output_tokens ?? 0;

  if (typeof input === "number") return annotate(usageAttributes(model, input, output));

  return estimate === undefined ? Effect.void : annotate(usageAttributes(model, estimate, 0, true));
};

const json = (value: unknown) => JSON.stringify(value);

/**
 * Starts a second call when the first has not answered after `delayMs`, and returns the first answer. Workers AI
 * sometimes holds one reader call for over a minute, while the same frame answers in seconds when sent again.
 * It fails when the second call fails, or when neither answers in 4 × `delayMs`, so the step can retry. The call
 * that loses is interrupted.
 */
export const hedge = <A, E, R>(model: string, delayMs: number, call: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error, R> =>
  Effect.gen(function* () {
    const first = yield* Effect.forkChild(call);
    // `exit`, because a timeout would otherwise wait out a first call that fails early.
    const early = yield* Effect.timeoutOption(Effect.exit(Fiber.join(first)), delayMs);

    if (Option.isSome(early)) return yield* early.value;
    yield* Effect.logWarning(`${model} gave no answer in ${delayMs} ms, sent the call again`).pipe(Effect.annotateLogs({ "gen_ai.request.model": model }));
    yield* annotate({ "app.hedged": true });

    // A failed first call leaves the answer to the second; a failed second call fails the hedge.
    return yield* Effect.raceFirst(Effect.catchCause(Fiber.join(first), () => Effect.never), call);
  }).pipe(Effect.timeoutOrElse({ duration: 4 * delayMs, orElse: () => Effect.fail(new Error(`${model} gave no answer in ${4 * delayMs} ms`)) }));

export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";

  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));

  return btoa(binary);
}

function askAboutFrame<Q extends string>(state: string, questions: Record<Q, string>, jpeg: ArrayBuffer, frame: FrameReference) {
  const names = Object.keys(questions) as Q[];
  const asked = Object.fromEntries(names.map((name) => [name, { type: "noul", instructions: questions[name] }]));

  return Effect.gen(function* () {
    const result = yield* runModel(FLASH, { model: "clef-flash", state, images: [{ content_type: "image/jpeg", base64: toBase64(jpeg) }], questions: asked });
    yield* recordUsage(FLASH, result);
    yield* annotate({ "gen_ai.output.messages": json(result?.answers ?? null) });

    return Object.fromEntries(names.map((name) => {
      const p = result?.answers?.[name]?.noul;

      if (typeof p !== "number") throw new Error(`clef-flash returned no answer: ${json(result).slice(0, 200)}`);

      return [name, p];
    })) as Record<Q, number>;
  }).pipe(modelSpan(FLASH, { ...frameAttributes(frame), "gen_ai.input.messages": json([{ role: "user", state, questions: asked }]) }));
}

/** Probability that an X post (or whatever the detector looks for) is on screen. */
export const detectFrame = (detector: Detector, jpeg: ArrayBuffer, frame: FrameReference) =>
  Effect.map(askAboutFrame(detector.frameState, { frame: detector.frameQuestion }, jpeg, frame), (answers) => answers.frame);

function askReader(prompt: string, maxTokens: number, jpeg: ArrayBuffer, frame: FrameReference) {
  const messages = [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${toBase64(jpeg)}` } }] }];
  const inputs = { max_tokens: maxTokens, temperature: 0, chat_template_kwargs: { enable_thinking: false }, messages };
  const attributes = frameAttributes(frame);

  return Effect.gen(function* () {
    const result = yield* hedge(READER, READ_HEDGE_MS, runModel(READER, inputs));
    yield* recordUsage(READER, result);
    const choice = result?.choices?.[0];
    const text = choice?.message?.content ?? result?.response;

    if (typeof text !== "string") return yield* Effect.fail(new Error(`${READER} returned no text: ${json(result).slice(0, 200)}`));
    yield* annotate({ "gen_ai.output.messages": json([{ role: "assistant", parts: [{ type: "text", content: text }], finish_reason: choice?.finish_reason }]) });

    return text;
  }).pipe(modelSpan(READER, { ...attributes, "gen_ai.request.max_tokens": maxTokens, "gen_ai.input.messages": redactImages(json(messages), attributes["app.frame.url"]) }));
}

/** The reader lists stream chat and other sites as X posts, so the full-size frame is checked first and the source is asked apart. */
export const readPosts = (detector: Detector, jpeg: ArrayBuffer, frame: FrameReference): Effect.Effect<ReaderLine[], unknown, Bindings> =>
  Effect.gen(function* () {
    const { page, chat } = yield* askAboutFrame(detector.frameState, { page: detector.frameQuestion, chat: detector.chatQuestion }, jpeg, frame);
    const skip = page < detector.pageThreshold ? "not_x" : chat >= detector.chatThreshold ? "chat" : null;

    if (skip) {
      yield* annotate({ "read.frame_result": skip });

      return [];
    }

    const [output, source] = yield* Effect.all([
      askReader(detector.readerPrompt, 1500, jpeg, frame),
      askReader(detector.sourceQuestion, 5, jpeg, frame),
    ], { concurrency: 2 });

    const notPost = /^\W*(chat|other)\b/i.test(source);
    yield* annotate({ "read.frame_result": notPost ? "not_post" : "read" });

    return notPost ? [] : parseReaderLines(output);
  }).pipe(span("read frame", "function", frameAttributes(frame)));

export const readAloudProbability = (detector: Detector, post: Post, transcript: string) => {
  const questions = { read: { type: "noul", instructions: detector.readAloudQuestion(post) } };

  return Effect.gen(function* () {
    const result = yield* runModel(CLEF, { model: "clef", state: transcript, questions });
    yield* recordUsage(CLEF, result);
    const p = result?.answers?.read?.noul;

    if (typeof p !== "number") return yield* Effect.fail(new Error(`clef returned no answer: ${json(result).slice(0, 200)}`));
    yield* annotate({ "gen_ai.output.messages": json(result.answers) });

    return p as number;
  }).pipe(modelSpan(CLEF, { "app.task": "read-aloud check", "gen_ai.input.messages": json([{ role: "user", state: transcript, questions }]) }));
};

/** `question` and `answer` are what Clairic was asked and said, which a trace needs when the app does not use the answer. */
export type QuoteSearch = {
  question: string;
  answer: string | null;
  span: [number, number] | null;
  how: "read" | "word_run" | "own_words" | null;
};

/**
 * Where in the transcript the speaker says the post. Asked for a word-for-word reading of a post the speaker puts in
 * their own words, Clairic still picks a sentence, often an unrelated one, so the question depends on whether the
 * post's words are in the transcript.
 */
export const findQuote = (detector: Detector, post: Post, transcript: string): Effect.Effect<QuoteSearch, unknown, Bindings> => {
  const run = wordRunSpan(post.text, transcript);
  const question = run ? detector.quoteInstructions(post) : detector.ownWordsInstructions(post);
  const fields = { quote: { type: "text", instructions: question } };

  return Effect.gen(function* () {
    const result = yield* runModel(CLAIRIC, { model: "clairic", state: transcript, fields });
    yield* recordUsage(CLAIRIC, result);
    const raw = result?.answers?.quote?.span;
    const answer = Array.isArray(raw) ? transcript.slice(raw[0], raw[1]) : null;
    yield* annotate({ "gen_ai.output.messages": json([{ role: "assistant", parts: [{ type: "text", content: answer }] }]) });
    const span = quoteSpan(raw, transcript);

    if (span) return { question, answer, span, how: run ? "read" : "own_words" } as const;

    return { question, answer, span: run, how: run && "word_run" } as QuoteSearch;
  }).pipe(modelSpan(CLAIRIC, { "app.task": "quote finder", "gen_ai.input.messages": json([{ role: "user", state: transcript, fields }]) }));
};

/** Word timings for one audio chunk; `offsetSeconds` is the chunk start in the video. Whisper is priced by audio minute. */
export const transcribe = (mp3: ArrayBuffer, offsetSeconds: number): Effect.Effect<Word[], unknown, Bindings> =>
  Effect.gen(function* () {
    const result = yield* runModel(WHISPER, { audio: toBase64(mp3) });
    yield* annotate(whisperCostAttributes(result?.transcription_info?.duration ?? 0));

    return wordsFromSegments(result?.segments ?? [], offsetSeconds);
  }).pipe(modelSpan(WHISPER, { "app.audio_offset": offsetSeconds, "gen_ai.input.messages": `[audio/mpeg, ${Math.round(mp3.byteLength / 1024)} KB]` }));

/** bge-m3 pads each text to the longest one in its request, and counts the padded tokens against this limit. */
const EMBED_REQUEST_TOKENS = 60_000;

/** English posts measured 3.7 characters per token. URLs, code and other scripts have fewer. */
const EMBED_CHARS_PER_TOKEN = 3;

/** Splits texts into bge-m3 requests whose padded size fits `EMBED_REQUEST_TOKENS`. */
export function embedRequests(texts: string[]): string[][] {
  const requests: string[][] = [];
  let request: string[] = [];
  let longest = 0;

  for (const text of texts) {
    const tokens = Math.ceil(text.length / EMBED_CHARS_PER_TOKEN);

    if (request.length && (request.length + 1) * Math.max(longest, tokens) > EMBED_REQUEST_TOKENS) {
      requests.push(request);
      request = [];
      longest = 0;
    }

    request.push(text);
    longest = Math.max(longest, tokens);
  }

  if (request.length) requests.push(request);

  return requests;
}

/** Error 8007 means the request was over the token limit, because other scripts and repeated symbols beat the estimate. */
const embedRequest = (request: string[]): Effect.Effect<number[][], unknown, Bindings> =>
  Effect.gen(function* () {
    // bge-m3 returns no token usage, so the span gets an estimate of 4 characters per token.
    const estimate = request.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

    const result = yield* Effect.result(runModel(EMBED, { text: request }).pipe(
      Effect.tap((result) => recordUsage(EMBED, result, estimate)),
      modelSpan(EMBED, { "gen_ai.input.messages": `[${request.length} texts]` }),
    ));

    if (result._tag === "Failure") {
      if (request.length === 1 || !/\b8007\b/.test(errorMessage(result.failure))) return yield* Effect.fail(result.failure);
      const half = request.length >> 1;

      return [...(yield* embedRequest(request.slice(0, half))), ...(yield* embedRequest(request.slice(half)))];
    }

    const data = result.success?.data;

    if (!Array.isArray(data) || data.length !== request.length) return yield* Effect.fail(new Error(`bge-m3 returned ${data?.length} vectors for ${request.length} texts`));

    return data as number[][];
  });

export const embed = (texts: string[]) =>
  Effect.map(Effect.forEach(embedRequests(texts), embedRequest), (parts) => parts.flat());
