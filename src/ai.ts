import { logger, metrics } from "@sentry/cloudflare";
import type { Detector, Post } from "./config";
import type { Env } from "./env";
import { parseReaderLines, wordsFromSegments, type ReaderLine, type Word } from "./pipeline";
import { chatSpan, transcribeSpan, withEstimatedInputTokens, withFrameReference, type FrameReference, WHISPER } from "./telemetry";

// The AI binding types in workers-types do not list these models.
type AnyRun = { run(model: string, inputs: unknown): Promise<any> };

const FLASH = "@cf/cloudflare/clef-flash";
const CLEF = "@cf/cloudflare/clef";
const CLAIRIC = "@cf/cloudflare/clairic";
const READER = "@cf/qwen/qwen3.8-27b";
const EMBED = "@cf/baai/bge-m3";
/** On 142 sampled frames half answered in 3.5 s, 7 took over 20 s and the slowest 37 s. Each of those 7 costs one extra call. */
const READ_HEDGE_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The wait before the next attempt, or null when a retry cannot help. Error 3021 is the per-minute limit on
 * inference requests, so it waits for the minute to move on, not for a second.
 */
export function retryDelayMs(err: unknown, attempt: number): number | null {
  const status = (err as { status?: number })?.status;
  const message = String((err as Error)?.message ?? err);
  const rateLimited = status === 429 || /\b(429|3021)\b|rate limit/i.test(message);
  const retryable = status !== undefined ? rateLimited || status >= 500 : rateLimited || /\b5\d\d\b|capacity|overloaded|timed? ?out|temporar|internal/i.test(message);
  if (!retryable) return null;
  return (rateLimited ? 10_000 : 1000) * 2 ** attempt + Math.random() * 500;
}

export async function runModel(env: Env, model: string, inputs: unknown, attempts = 3, abandoned = () => false): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await (env.AI as unknown as AnyRun).run(model, inputs);
    } catch (err) {
      const delay = retryDelayMs(err, attempt);
      if (attempt >= attempts - 1 || delay === null || abandoned()) throw err;
      const error = String((err as Error)?.message ?? err).slice(0, 300);
      logger.warn(logger.fmt`${model} failed, retry ${attempt + 1} of ${attempts - 1}`, { "gen_ai.request.model": model, error });
      metrics.count("ai.retry", 1, { attributes: { "gen_ai.request.model": model } });
      await sleep(delay);
      if (abandoned()) throw err;
    }
  }
}

/**
 * Starts a second call when the first has not answered after `delayMs`, and returns the first answer. Workers AI
 * sometimes holds one reader call for over a minute, while the same frame answers in seconds when sent again.
 * It fails when the second call fails, or when neither answers in 4 × `delayMs`, so the step can retry.
 */
export function hedge<T>(model: string, delayMs: number, call: (abandoned: () => boolean) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let running = 0;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const settle = <A>(fn: (value: A) => void) => (value: A) => {
      settled = true;
      timers.forEach(clearTimeout);
      fn(value);
    };
    const start = (second: boolean) => {
      running++;
      call(() => settled).then(settle(resolve), (err) => {
        if (--running === 0 || second) settle(reject)(err);
      });
    };
    timers.push(setTimeout(() => {
      logger.warn(logger.fmt`${model} gave no answer in ${delayMs} ms, sent the call again`, { "gen_ai.request.model": model });
      metrics.count("ai.hedge", 1, { attributes: { "gen_ai.request.model": model } });
      start(true);
    }, delayMs));
    timers.push(setTimeout(() => settle(reject)(new Error(`${model} gave no answer in ${4 * delayMs} ms`)), 4 * delayMs));
    start(false);
  });
}

export async function pool<T>(items: T[], size: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index], index);
      }
    }),
  );
}

export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function askAboutFrame<Q extends string>(env: Env, state: string, questions: Record<Q, string>, jpeg: ArrayBuffer, frame: FrameReference): Promise<Record<Q, number>> {
  const names = Object.keys(questions) as Q[];
  const result = await withFrameReference(frame, () => runModel(env, FLASH, {
    model: "clef-flash",
    state,
    images: [{ content_type: "image/jpeg", base64: toBase64(jpeg) }],
    questions: Object.fromEntries(names.map((name) => [name, { type: "noul", instructions: questions[name] }])),
  }));
  return Object.fromEntries(names.map((name) => {
    const p = result?.answers?.[name]?.noul;
    if (typeof p !== "number") throw new Error(`clef-flash returned no answer: ${JSON.stringify(result).slice(0, 200)}`);
    return [name, p];
  })) as Record<Q, number>;
}

/** Probability that an X post (or whatever the detector looks for) is on screen. */
export async function detectFrame(env: Env, detector: Detector, jpeg: ArrayBuffer, frame: FrameReference): Promise<number> {
  return (await askAboutFrame(env, detector.frameState, { frame: detector.frameQuestion }, jpeg, frame)).frame;
}

/** Raw reader output: one `@handle | display name | text` line per post. */
async function readFrame(env: Env, detector: Detector, jpeg: ArrayBuffer, frame: FrameReference): Promise<string> {
  const inputs = {
    max_tokens: 1500,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: detector.readerPrompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${toBase64(jpeg)}` } },
        ],
      },
    ],
  };
  const result = await withFrameReference(frame, () =>
    chatSpan(READER, inputs, () => hedge(READER, READ_HEDGE_MS, (abandoned) => runModel(env, READER, inputs, 3, abandoned))),
  );
  const text = result?.choices?.[0]?.message?.content ?? result?.response;
  if (typeof text !== "string") throw new Error(`${READER} returned no text: ${JSON.stringify(result).slice(0, 200)}`);
  return text;
}

/** The reader lists stream chat and other sites as X posts, so the full-size frame is checked first. */
export async function readPosts(env: Env, detector: Detector, jpeg: ArrayBuffer, frame: FrameReference): Promise<ReaderLine[]> {
  const { page, chat } = await askAboutFrame(env, detector.frameState, { page: detector.frameQuestion, chat: detector.chatQuestion }, jpeg, frame);
  const result = page < detector.pageThreshold ? "not_x" : chat >= detector.chatThreshold ? "chat" : "read";
  metrics.count("read.frames", 1, { attributes: { result } });
  return result === "read" ? parseReaderLines(await readFrame(env, detector, jpeg, frame)) : [];
}

export async function readAloudProbability(env: Env, detector: Detector, post: Post, transcript: string): Promise<number> {
  const result = await runModel(env, CLEF, {
    model: "clef",
    state: transcript,
    questions: { read: { type: "noul", instructions: detector.readAloudQuestion(post) } },
  });
  const p = result?.answers?.read?.noul;
  if (typeof p !== "number") throw new Error(`clef returned no answer: ${JSON.stringify(result).slice(0, 200)}`);
  return p;
}

/** Character span of the words in the transcript where the speaker reads the post, or null. */
export async function findQuoteSpan(
  env: Env,
  detector: Detector,
  post: Post,
  transcript: string,
): Promise<[number, number] | null> {
  const result = await runModel(env, CLAIRIC, {
    model: "clairic",
    state: transcript,
    fields: { quote: { type: "text", instructions: detector.quoteInstructions(post) } },
  });
  const span = result?.answers?.quote?.span;
  if (!Array.isArray(span) || typeof span[0] !== "number") return null;
  return [span[0], typeof span[1] === "number" ? span[1] : span[0] + 1];
}

/** Word timings for one audio chunk; `offsetSeconds` is the chunk start in the video. */
export async function transcribe(env: Env, mp3: ArrayBuffer, offsetSeconds: number): Promise<Word[]> {
  const result = await transcribeSpan(() => runModel(env, WHISPER, { audio: toBase64(mp3) }));
  return wordsFromSegments(result?.segments ?? [], offsetSeconds);
}

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
async function embedRequest(env: Env, request: string[]): Promise<number[][]> {
  let result;
  try {
    result = await withEstimatedInputTokens(request, () => runModel(env, EMBED, { text: request }));
  } catch (err) {
    if (request.length === 1 || !/\b8007\b/.test(String((err as Error)?.message ?? err))) throw err;
    const half = request.length >> 1;
    return [...(await embedRequest(env, request.slice(0, half))), ...(await embedRequest(env, request.slice(half)))];
  }
  if (!Array.isArray(result?.data) || result.data.length !== request.length) {
    throw new Error(`bge-m3 returned ${result?.data?.length} vectors for ${request.length} texts`);
  }
  return result.data;
}

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const request of embedRequests(texts)) vectors.push(...(await embedRequest(env, request)));
  return vectors;
}
