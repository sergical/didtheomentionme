import type { Detector, Post } from "./config";
import type { Env } from "./env";
import { wordsFromSegments, type Word } from "./pipeline";
import { transcribeSpan, withFrameReference, type FrameReference, WHISPER } from "./telemetry";

// The AI binding types in workers-types do not list these models.
type AnyRun = { run(model: string, inputs: unknown): Promise<any> };

const FLASH = "@cf/cloudflare/clef-flash";
const CLEF = "@cf/cloudflare/clef";
const CLAIRIC = "@cf/cloudflare/clairic";
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const EMBED = "@cf/baai/bge-m3";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== undefined) return status === 429 || status >= 500;
  return /\b(429|5\d\d)\b|capacity|overloaded|timed? ?out|temporar|internal/i.test(String((err as Error)?.message ?? err));
}

/** Calls a model, retrying 429 and 5xx with exponential backoff. */
export async function runModel(env: Env, model: string, inputs: unknown, attempts = 5): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await (env.AI as unknown as AnyRun).run(model, inputs);
    } catch (err) {
      if (attempt >= attempts - 1 || !isRetryable(err)) throw err;
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
    }
  }
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

/** Probability that an X post (or whatever the detector looks for) is on screen. */
export async function detectFrame(env: Env, detector: Detector, jpeg: ArrayBuffer, frame: FrameReference): Promise<number> {
  const result = await withFrameReference(frame, () => runModel(env, FLASH, {
    model: "clef-flash",
    state: detector.frameState,
    images: [{ content_type: "image/jpeg", base64: toBase64(jpeg) }],
    questions: { frame: { type: "noul", instructions: detector.frameQuestion } },
  }));
  const p = result?.answers?.frame?.noul;
  if (typeof p !== "number") throw new Error(`clef-flash returned no answer: ${JSON.stringify(result).slice(0, 200)}`);
  return p;
}

/** Raw reader output: one `@handle | display name | text` line per post. */
export async function readFrame(env: Env, detector: Detector, jpeg: ArrayBuffer, frame: FrameReference): Promise<string> {
  const result = await withFrameReference(frame, () => runModel(env, GEMMA, {
    max_tokens: 1500,
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
  }));
  const text = result?.choices?.[0]?.message?.content ?? result?.response;
  if (typeof text !== "string") throw new Error(`gemma-4 returned no text: ${JSON.stringify(result).slice(0, 200)}`);
  return text;
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

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const result = await runModel(env, EMBED, { text: texts });
  if (!Array.isArray(result?.data) || result.data.length !== texts.length) {
    throw new Error(`bge-m3 returned ${result?.data?.length} vectors for ${texts.length} texts`);
  }
  return result.data;
}
