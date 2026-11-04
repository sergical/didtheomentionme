import * as Sentry from "@sentry/cloudflare";
import { SentrySpan } from "@sentry/core";
import type { WorkflowSleepDuration, WorkflowStepConfig, WorkflowStepContext } from "cloudflare:workers";
import type { Env } from "./env";

const KB = (base64Length: number) => Math.round((base64Length * 3) / 4 / 1024);

/** Cloudflare's USD prices per 1M tokens. Sentry's own price list can match a reseller's price for an `@cf/` model. */
const PRICES: Record<string, { input: number; output?: number }> = {
  "@cf/cloudflare/clef-flash": { input: 0.038 },
  "@cf/cloudflare/clef": { input: 0.24 },
  "@cf/cloudflare/clairic": { input: 0.1 },
  "@cf/google/gemma-4-26b-a4b-it": { input: 0.1, output: 0.3 },
  "@cf/baai/bge-m3": { input: 0.012 },
};

export const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const WHISPER_USD_PER_MINUTE = 0.0005;
/** The step that keeps a phase's span id and start. It has no work to show. */
const PHASE_START = /^phase:/;

/** No DSN turns Sentry off. */
export const sentryOptions = (env: Env): Sentry.CloudflareOptions => ({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 1,
  environment: "production",
  // The SDK records no audio length for whisper, so `transcribeSpan` makes the whisper span.
  ignoreSpans: [{ name: `chat ${WHISPER}` }, { name: PHASE_START }],
  integrations: [{
    name: "ScopeAttributes",
    setup(client) {
      client.on("spanStart", (span) => {
        const data = Sentry.spanToJSON(span);
        if (!String(data.attributes["sentry.op"]).startsWith("gen_ai")) return;
        const { frame, usage } = Sentry.getCurrentScope().getScopeData().contexts;
        for (const context of [frame, usage]) {
          for (const [key, value] of Object.entries(context ?? {})) {
            if (typeof value === "string" || typeof value === "number") span.setAttribute(key, value);
          }
        }
      });
    },
  }],
  beforeSendSpan(span) {
    const estimate = span.attributes["app.estimated_input_tokens"];
    if (span.attributes["gen_ai.usage.input_tokens"] == null && typeof estimate === "number") {
      span.attributes["gen_ai.usage.input_tokens"] = estimate;
      span.attributes["gen_ai.usage.total_tokens"] = estimate;
      span.attributes["app.tokens_estimated"] = true;
    }
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

/** The steps inside a phase. Each one passes a config, so `do` needs only that overload. */
export type PhaseStep = {
  do<T extends Rpc.Serializable<T>>(name: string, config: WorkflowStepConfig, callback: (ctx: WorkflowStepContext) => Promise<T>): Promise<T>;
  sleep(name: string, duration: WorkflowSleepDuration): Promise<void>;
};

/**
 * Groups Workflow steps under one span. Each step stays its own segment, so its name still names the spans in it,
 * and points to the phase as its parent. The Worker can restart inside a phase, for example at a sleep, so the
 * phase's span id and start time come from a step: every restart gets them back, and steps from all restarts
 * point to the same phase. A replay returns finished steps without running them, so the phase is sent only by
 * the run that ends it after one of its steps ran.
 */
export async function phase<T>(
  name: string,
  step: PhaseStep,
  fn: (step: PhaseStep) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const key = [name, ...Object.values(attributes ?? {})].join(":");
  const { spanId, startedAt } = await step.do(`phase:${key}`, {}, async () => ({
    spanId: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    startedAt: Date.now(),
  }));
  let ran = false;
  const tracked: PhaseStep = {
    do: (stepName, config, callback) =>
      step.do(stepName, config, (ctx) => {
        ran = true;
        return callback(ctx);
      }),
    sleep: (stepName, duration) => step.sleep(stepName, duration),
  };
  return Sentry.withScope(async (scope) => {
    const context = scope.getPropagationContext();
    scope.setPropagationContext({ ...context, parentSpanId: spanId });
    const span = () =>
      new SentrySpan({ traceId: context.traceId, spanId, name, op: "workflow.phase", attributes, startTimestamp: startedAt / 1000, sampled: true });
    try {
      const result = await fn(tracked);
      if (ran) span().end();
      return result;
    } catch (err) {
      if (ran) span().setStatus({ code: 2, message: "internal_error" }).end();
      throw err;
    }
  });
}

/** bge-m3 returns no token usage, so its embeddings span gets an estimate of 4 characters per token. */
export const withEstimatedInputTokens = <T>(texts: string[], fn: () => Promise<T>) =>
  Sentry.withScope((scope) => {
    scope.setContext("usage", { "app.estimated_input_tokens": texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) });
    return fn();
  });

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
const FRAME_ORIGIN = "https://didtheomention.me";

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
