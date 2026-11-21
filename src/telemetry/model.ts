/** Telemetry facts that both exporters send in the same shape. Nothing here knows which exporter runs. */

export type Attributes = Record<string, string | number | boolean | undefined>;

/** Cloudflare's USD prices per 1M tokens. Sentry's own price list can match a reseller's price for an `@cf/` model. */
export const PRICES: Record<string, { input: number; output?: number }> = {
  "@cf/cloudflare/clef-flash": { input: 0.038 },
  "@cf/cloudflare/clef": { input: 0.24 },
  "@cf/cloudflare/clairic": { input: 0.1 },
  "@cf/qwen/qwen3.8-27b": { input: 0.45, output: 3.2 },
  "@cf/baai/bge-m3": { input: 0.012 },
};

export const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const WHISPER_USD_PER_MINUTE = 0.0005;

/** The gen_ai operation of each model, which Sentry turns into the span op `gen_ai.<operation>`. */
export const OPERATIONS: Record<string, string> = {
  "@cf/cloudflare/clef-flash": "decide",
  "@cf/cloudflare/clef": "decide",
  "@cf/cloudflare/clairic": "extract",
  "@cf/qwen/qwen3.8-27b": "chat",
  "@cf/baai/bge-m3": "embeddings",
  [WHISPER]: "generate_content",
};

/** Token usage and cost attributes, in the names Sentry's AI Agents views read. */
export function usageAttributes(model: string, input: number, output = 0, estimated = false): Attributes {
  const price = PRICES[model];
  const inputCost = price ? (input * price.input) / 1e6 : undefined;
  const outputCost = price ? (output * (price.output ?? 0)) / 1e6 : undefined;
  return {
    "gen_ai.usage.input_tokens": input,
    "gen_ai.usage.output_tokens": output,
    "gen_ai.usage.total_tokens": input + output,
    "gen_ai.cost.input_tokens": inputCost,
    "gen_ai.cost.output_tokens": outputCost,
    "gen_ai.cost.total_tokens": inputCost === undefined ? undefined : inputCost + (outputCost ?? 0),
    "app.tokens_estimated": estimated || undefined,
  };
}

export const whisperCostAttributes = (seconds: number): Attributes => ({
  "app.audio_seconds": seconds,
  "gen_ai.cost.total_tokens": (seconds / 60) * WHISPER_USD_PER_MINUTE,
});

export type FrameReference = { videoId: string; second: number; size: "f640" | "f1920" };
const FRAME_ORIGIN = "https://didtheomention.me";

export function frameAttributes(frame: FrameReference): Attributes {
  return {
    "app.frame.key": `videos/${frame.videoId}/${frame.size}/${frame.second}.jpg`,
    "app.frame.second": frame.second,
    "app.frame.url": `${FRAME_ORIGIN}/frame/${frame.videoId}/${frame.second}.jpg${frame.size === "f640" ? "?size=640" : ""}`,
    "app.frame.youtube_url": `https://www.youtube.com/watch?v=${frame.videoId}&t=${frame.second}s`,
  };
}

const KB = (base64Length: number) => Math.round((base64Length * 3) / 4 / 1024);

/** A frame sent to the reader would add its full base64 JPEG to `gen_ai.input.messages`. */
export function redactImages(messages: string, frameUrl: unknown): string {
  const reference = typeof frameUrl === "string" ? frameUrl : undefined;
  return messages.replace(/data:([\w/+.-]+);base64,[A-Za-z0-9+/=]+/g, (match, type: string) => reference ?? `[${type}, ${KB(match.length)} KB]`);
}

async function sha1Hex(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The trace id of a Workflow instance. It is the one the Sentry SDK gives the instance, so both exporters agree. */
export const workflowTraceId = async (instanceId: string) => (await sha1Hex(instanceId)).slice(0, 32);

/** The span id of the span that covers a whole Workflow run. Every step can compute it, so none has to store it. */
export const workflowRootSpanId = async (instanceId: string) => (await sha1Hex(`${instanceId}:run`)).slice(0, 16);

export const randomSpanId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/** A span that outlives one Worker invocation, so it is written once at its end with the id and start it kept. */
export interface RecordedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  op: string;
  startMs: number;
  endMs: number;
  failed: boolean;
  attributes?: Attributes;
}

export const errorMessage = (err: unknown) => String((err as Error)?.message ?? err);

/** Headers that let the container's Python SDK continue a trace, in Sentry's and OpenTelemetry's formats. */
export const spanHeaders = (span: { traceId: string; spanId: string } | undefined): Record<string, string> =>
  span ? { "sentry-trace": `${span.traceId}-${span.spanId}-1`, traceparent: `00-${span.traceId}-${span.spanId}-01` } : {};
