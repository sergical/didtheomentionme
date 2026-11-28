import { Effect, Fiber, Option, Result, Schema } from "effect";
import type { Detector, Post } from "./config";
import type { Json, ModelInputs } from "./env";
import { parseReaderLines, quoteSpan, wordRunSpan, wordsFromSegments, type ReaderLine, type Word } from "./pipeline";
import { Bindings, annotate, span } from "./runtime";
import { OPERATIONS, WHISPER, errorMessage, frameAttributes, redactImages, usageAttributes, whisperCostAttributes, type Attributes, type FrameReference } from "./telemetry";

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
export function retryDelayMs(cause: unknown, attempt: number): number | null {
  const status = Option.getOrUndefined(decodeStatus(cause))?.status;
  const message = errorMessage(cause);
  const rateLimited = status === 429 || /\b(429|3021)\b|rate limit/i.test(message);
  const retryable = status !== undefined ? rateLimited || status >= 500 : rateLimited || /\b5\d\d\b|capacity|overloaded|timed? ?out|temporar|internal/i.test(message);

  if (!retryable) return null;

  return (rateLimited ? 10_000 : 1000) * 2 ** attempt + Math.random() * 500;
}

const decodeStatus = Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Number }));

/** One binding call, retried while a retry can help. An interrupted call, for example a hedge's loser, stops retrying. */
export const runModel = (model: string, inputs: ModelInputs, attempts = 3): Effect.Effect<Json, unknown, Bindings> =>
  Effect.gen(function* () {
    const env = yield* Bindings;

    for (let attempt = 0; ; attempt++) {
      const result = yield* Effect.result(Effect.tryPromise({ try: () => env.AI.run(model, inputs), catch: (cause) => cause }));

      if (Result.isSuccess(result)) {
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
  span(`${OPERATIONS.get(model) ?? "run"} ${model}`, `gen_ai.${OPERATIONS.get(model) ?? "run"}`, {
    "gen_ai.operation.name": OPERATIONS.get(model) ?? "run",
    "gen_ai.provider.name": "cloudflare.workers_ai",
    "gen_ai.request.model": model,
    ...attributes,
  });

const Tokens = Schema.optional(Schema.Number);
const decodeUsage = Schema.decodeUnknownOption(Schema.Struct({ usage: Schema.Struct({ prompt_tokens: Tokens, input_tokens: Tokens, completion_tokens: Tokens, output_tokens: Tokens }) }));

/** The tokens a model reports, under either pair of names the models use. */
const tokensOf = (result: Json) => {
  const usage = Option.getOrUndefined(decodeUsage(result))?.usage;

  return { input: usage?.prompt_tokens ?? usage?.input_tokens, output: usage?.completion_tokens ?? usage?.output_tokens ?? 0 };
};

/** Usage from the answer, or an estimate of 4 characters per token when the model reports none. */
const recordUsage = (model: string, result: Json, estimate?: number) => {
  const { input, output } = tokensOf(result);

  if (input !== undefined) return annotate(usageAttributes(model, input, output));

  return estimate === undefined ? Effect.void : annotate(usageAttributes(model, estimate, 0, true));
};

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

const decodeAnswers = Schema.decodeUnknownOption(Schema.Struct({ answers: Schema.Record(Schema.String, Schema.Struct({ noul: Schema.Number })) }));

/** The yes-or-no answers of clef or clef-flash by question name, or null when the result has none. */
const answersOf = (result: Json) => Option.getOrNull(Option.map(decodeAnswers(result), (decoded) => decoded.answers));

/** The probability of each named question, in the order of `names`. Fails when the model answered none of them. */
const probabilities = (label: string, result: Json, names: string[]) => {
  const answers = answersOf(result) ?? {};
  const found = names.flatMap((name) => (name in answers ? [answers[name].noul] : []));

  return found.length === names.length ? Effect.succeed(found) : Effect.fail(new Error(`${label} returned no answer: ${JSON.stringify(result).slice(0, 200)}`));
};

/** One yes-or-no question about a frame, under the name its answer comes back with. */
interface FrameQuestion {
  name: string;
  instructions: string;
}

/** Asks clef-flash about one frame, and gives the probability of each question in the order asked. */
function askAboutFrame(state: string, questions: FrameQuestion[], jpeg: ArrayBuffer, frame: FrameReference) {
  const asked = Object.fromEntries(questions.map(({ name, instructions }) => [name, { type: "noul", instructions }]));

  return Effect.gen(function* () {
    const result = yield* runModel(FLASH, { model: "clef-flash", state, images: [{ content_type: "image/jpeg", base64: toBase64(jpeg) }], questions: asked });
    yield* recordUsage(FLASH, result);
    yield* annotate({ "gen_ai.output.messages": JSON.stringify(answersOf(result)) });

    return yield* probabilities("clef-flash", result, questions.map((question) => question.name));
  }).pipe(modelSpan(FLASH, { ...frameAttributes(frame), "gen_ai.input.messages": JSON.stringify([{ role: "user", state, questions: asked }]) }));
}

/** Probability that an X post (or whatever the detector looks for) is on screen. */
export const detectFrame = (detector: Detector, jpeg: ArrayBuffer, frame: FrameReference) =>
  Effect.map(askAboutFrame(detector.frameState, [{ name: "frame", instructions: detector.frameQuestion }], jpeg, frame), ([onScreen]) => onScreen);

const Text = Schema.optional(Schema.NullOr(Schema.String));

const decodeChat = Schema.decodeUnknownOption(Schema.Struct({
  choices: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.Struct({ content: Text })), finish_reason: Text }))),
  response: Text,
}));

function askReader(prompt: string, maxTokens: number, jpeg: ArrayBuffer, frame: FrameReference) {
  const text = { type: "text", text: prompt };
  const image = { type: "image_url", image_url: { url: `data:image/jpeg;base64,${toBase64(jpeg)}` } };
  const messages = [{ role: "user", content: [text, image] }];
  const inputs = { max_tokens: maxTokens, temperature: 0, chat_template_kwargs: { enable_thinking: false }, messages };
  const attributes = frameAttributes(frame);

  return Effect.gen(function* () {
    const result = yield* hedge(READER, READ_HEDGE_MS, runModel(READER, inputs));
    yield* recordUsage(READER, result);
    const chat = Option.getOrUndefined(decodeChat(result));
    const choice = chat?.choices?.[0];
    const answer = choice?.message?.content ?? chat?.response ?? null;

    if (answer === null) return yield* Effect.fail(new Error(`${READER} returned no text: ${JSON.stringify(result).slice(0, 200)}`));
    yield* annotate({ "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: answer }], finish_reason: choice?.finish_reason }]) });

    return answer;
  }).pipe(modelSpan(READER, { ...attributes, "gen_ai.request.max_tokens": maxTokens, "gen_ai.input.messages": redactImages(JSON.stringify(messages), attributes["app.frame.url"]) }));
}

/** The reader lists stream chat and other sites as X posts, so the full-size frame is checked first and the source is asked apart. */
export const readPosts = (detector: Detector, jpeg: ArrayBuffer, frame: FrameReference): Effect.Effect<ReaderLine[], unknown, Bindings> =>
  Effect.gen(function* () {
    const [page, chat] = yield* askAboutFrame(detector.frameState, [{ name: "page", instructions: detector.frameQuestion }, { name: "chat", instructions: detector.chatQuestion }], jpeg, frame);
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
    const [read] = yield* probabilities("clef", result, ["read"]);
    yield* annotate({ "gen_ai.output.messages": JSON.stringify(answersOf(result)) });

    return read;
  }).pipe(modelSpan(CLEF, { "app.task": "read-aloud check", "gen_ai.input.messages": JSON.stringify([{ role: "user", state: transcript, questions }]) }));
};

/** `question` and `answer` are what Clairic was asked and said, which a trace needs when the app does not use the answer. */
export type QuoteSearch = {
  question: string;
  answer: string | null;
  span: [number, number] | null;
  how: "read" | "word_run" | "own_words" | null;
};

const decodeQuote = Schema.decodeUnknownOption(Schema.Struct({ answers: Schema.Struct({ quote: Schema.Struct({ span: Schema.Tuple([Schema.Number, Schema.Number]) }) }) }));

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
    const raw = Option.getOrNull(Option.map(decodeQuote(result), (decoded) => decoded.answers.quote.span));
    const answer = raw ? transcript.slice(raw[0], raw[1]) : null;
    yield* annotate({ "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: answer }] }]) });
    const span = raw && quoteSpan(raw, transcript);
    const found: QuoteSearch = span ? { question, answer, span, how: run ? "read" : "own_words" } : { question, answer, span: run, how: run ? "word_run" : null };

    return found;
  }).pipe(modelSpan(CLAIRIC, { "app.task": "quote finder", "gen_ai.input.messages": JSON.stringify([{ role: "user", state: transcript, fields }]) }));
};

const decodeTranscript = Schema.decodeUnknownOption(Schema.Struct({
  transcription_info: Schema.optional(Schema.Struct({ duration: Schema.optional(Schema.Number) })),
  segments: Schema.optional(Schema.Array(Schema.Struct({
    start: Schema.Number,
    end: Schema.Number,
    text: Schema.String,
    words: Schema.optional(Schema.Array(Schema.Struct({ word: Schema.String, start: Schema.Number, end: Schema.Number }))),
  }))),
}));

/** Word timings for one audio chunk; `offsetSeconds` is the chunk start in the video. Whisper is priced by audio minute. */
export const transcribe = (mp3: ArrayBuffer, offsetSeconds: number): Effect.Effect<Word[], unknown, Bindings> =>
  Effect.gen(function* () {
    const result = yield* runModel(WHISPER, { audio: toBase64(mp3) });
    const transcript = Option.getOrNull(decodeTranscript(result));

    if (!transcript) return yield* Effect.fail(new Error(`${WHISPER} returned no transcript: ${JSON.stringify(result).slice(0, 200)}`));
    yield* annotate(whisperCostAttributes(transcript.transcription_info?.duration ?? 0));

    return wordsFromSegments(transcript.segments ?? [], offsetSeconds);
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

const decodeVectors = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(Schema.Number)))) }));

/** Error 8007 means the request was over the token limit, because other scripts and repeated symbols beat the estimate. */
const embedRequest = (request: string[]): Effect.Effect<number[][], unknown, Bindings> =>
  Effect.gen(function* () {
    // bge-m3 returns no token usage, so the span gets an estimate of 4 characters per token.
    const estimate = request.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

    const result = yield* Effect.result(runModel(EMBED, { text: request }).pipe(
      Effect.tap((result) => recordUsage(EMBED, result, estimate)),
      modelSpan(EMBED, { "gen_ai.input.messages": `[${request.length} texts]` }),
    ));

    if (Result.isFailure(result)) {
      if (request.length === 1 || !/\b8007\b/.test(errorMessage(result.failure))) return yield* Effect.fail(result.failure);
      const half = request.length >> 1;

      return [...(yield* embedRequest(request.slice(0, half))), ...(yield* embedRequest(request.slice(half)))];
    }

    const data = Option.getOrUndefined(decodeVectors(result.success))?.data;

    if (!data || data.length !== request.length) return yield* Effect.fail(new Error(`bge-m3 returned ${data?.length} vectors for ${request.length} texts`));

    return data;
  });

export const embed = (texts: string[]) =>
  Effect.map(Effect.forEach(embedRequests(texts), embedRequest), (parts) => parts.flat());
