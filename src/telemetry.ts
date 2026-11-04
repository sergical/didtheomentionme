import * as Sentry from "@sentry/cloudflare";
import type { Env } from "./env";

const KB = (base64Length: number) => Math.round((base64Length * 3) / 4 / 1024);

/** Cloudflare's USD prices per 1M tokens. Sentry's own price list can match a reseller's price for an `@cf/` model. */
const PRICES: Record<string, { input: number; output?: number }> = {
  "@cf/cloudflare/clef-flash": { input: 0.038 },
  "@cf/cloudflare/clef": { input: 0.24 },
  "@cf/cloudflare/clairic": { input: 0.1 },
  "@cf/google/gemma-4-26b-a4b-it": { input: 0.1, output: 0.3 },
};

export const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const WHISPER_USD_PER_MINUTE = 0.0005;

/** No DSN turns Sentry off. */
export const sentryOptions = (env: Env): Sentry.CloudflareOptions => ({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 1,
  environment: "production",
  // The SDK records no audio length for whisper, so `transcribeSpan` makes the whisper span.
  ignoreSpans: [{ name: `chat ${WHISPER}` }],
  integrations: [{
    name: "FrameReference",
    setup(client) {
      client.on("spanStart", (span) => {
        const data = Sentry.spanToJSON(span);
        if (!String(data.attributes["sentry.op"]).startsWith("gen_ai")) return;
        const frame = Sentry.getCurrentScope().getScopeData().contexts.frame;
        if (frame) {
          for (const [key, value] of Object.entries(frame)) {
            if (typeof value === "string" || typeof value === "number") span.setAttribute(key, value);
          }
        }
      });
    },
  }],
  beforeSendSpan(span) {
    const price = PRICES[String(span.attributes["gen_ai.request.model"])];
    if (price) {
      const tokens = (key: string) => Number(span.attributes[key]) || 0;
      const inputCost = (tokens("gen_ai.usage.input_tokens") * price.input) / 1e6;
      const outputCost = (tokens("gen_ai.usage.output_tokens") * (price.output ?? 0)) / 1e6;
      span.attributes["gen_ai.cost.input_tokens"] = inputCost;
      span.attributes["gen_ai.cost.output_tokens"] = outputCost;
      span.attributes["gen_ai.cost.total_tokens"] = inputCost + outputCost;
    }
    // The SDK records gen_ai inputs as they are, so each frame sent to gemma would add its full base64 JPEG.
    const messages = span.attributes["gen_ai.input.messages"];
    if (typeof messages === "string") {
      span.attributes["gen_ai.input.messages"] = redactImages(messages, span.attributes["app.frame.url"]);
    }
    return span;
  },
});

/** A named span, so a lookup or cron trace reads like the code runs. */
export const step = <T>(name: string, fn: () => Promise<T>, attributes?: Record<string, string | number | boolean>) =>
  Sentry.startSpan({ name, op: "function", attributes }, fn);

/** The trace id Sentry gives a Workflow instance, so a cron or admin span can point to the video's trace. */
export async function workflowTraceId(instanceId: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(instanceId)));
  return Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A gen_ai span for one whisper call, priced by audio minute. */
export const transcribeSpan = <T extends { transcription_info?: { duration?: number } }>(fn: () => Promise<T>) =>
  Sentry.startSpan(
    { name: `generate_content ${WHISPER}`, op: "gen_ai.generate_content", attributes: { "gen_ai.request.model": WHISPER } },
    async (span) => {
      const result = await fn();
      const minutes = (result?.transcription_info?.duration ?? 0) / 60;
      span.setAttribute("gen_ai.cost.total_tokens", minutes * WHISPER_USD_PER_MINUTE);
      return result;
    },
  );

export type FrameReference = { videoId: string; second: number; size: "f640" | "f1280" };
const FRAME_ORIGIN = "https://didtheomentionme.s-a62.workers.dev";

export function frameAttributes(frame: FrameReference) {
  return {
    "app.frame.key": `videos/${frame.videoId}/${frame.size}/${frame.second}.jpg`,
    "app.frame.second": frame.second,
    "app.frame.url": `${FRAME_ORIGIN}/frame/${frame.videoId}/${frame.second}.jpg${frame.size === "f640" ? "?size=640" : ""}`,
    "app.frame.youtube_url": `https://www.youtube.com/watch?v=${frame.videoId}&t=${frame.second}s`,
  };
}

/** Scope context isolates concurrent calls without adding a span per frame. */
export const withFrameReference = <T>(frame: FrameReference, fn: () => Promise<T>) =>
  Sentry.withScope((scope) => {
    scope.setContext("frame", frameAttributes(frame));
    return fn();
  });

export function redactImages(messages: string, frameUrl: unknown): string {
  const reference = typeof frameUrl === "string" ? frameUrl : undefined;
  return messages
    .replace(/data:([\w/+.-]+);base64,[A-Za-z0-9+/=]+/g,
      (match, type: string) => reference ?? `[${type}, ${KB(match.length)} KB]`);
}
