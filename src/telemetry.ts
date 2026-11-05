import * as Sentry from "@sentry/cloudflare";
import { SentrySpan } from "@sentry/core";
import type { WorkflowStepConfig, WorkflowStepContext, WorkflowStepEvent, WorkflowTimeoutDuration } from "cloudflare:workers";
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
/** The steps that open and close a phase. They have no work to show. */
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
  waitForEvent<T extends Rpc.Serializable<T>>(name: string, options: { type: string; timeout?: WorkflowTimeoutDuration }): Promise<WorkflowStepEvent<T>>;
};

/**
 * Groups Workflow steps under one span. Each step stays its own segment, so its name still names the spans in it,
 * and points to the phase as its parent. The Worker can restart inside a phase, for example while it waits for an
 * event, so a first step keeps the phase's span id and start time for every restart, and a last step sends the phase
 * span once.
 */
export async function phase<T>(
  name: string,
  step: PhaseStep,
  fn: (step: PhaseStep) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
  op = "workflow.phase",
): Promise<T> {
  const start = `phase:${[name, ...Object.values(attributes ?? {})].join(":")}`;
  const { spanId, startedAt } = await step.do(start, {}, async () => ({
    spanId: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    startedAt: Date.now(),
  }));
  return Sentry.withScope(async (scope) => {
    const context = scope.getPropagationContext();
    scope.setPropagationContext({ ...context, parentSpanId: spanId });
    const end = (failed: boolean) =>
      step.do(`${start}:end`, {}, async () => {
        const span = new SentrySpan({
          traceId: context.traceId,
          spanId,
          parentSpanId: context.parentSpanId,
          name,
          op,
          attributes,
          startTimestamp: startedAt / 1000,
          sampled: true,
        });
        if (failed) span.setStatus({ code: 2, message: "internal_error" });
        span.end();
      });
    try {
      const result = await fn(step);
      await end(false);
      return result;
    } catch (err) {
      await end(true);
      throw err;
    }
  });
}

/** waitForEvent makes no span, so the wait runs as a phase of its own. A timeout ends that span as an error. */
export const waitForEvent = <T extends Rpc.Serializable<T>>(step: PhaseStep, name: string, options: { type: string; timeout?: WorkflowTimeoutDuration }) =>
  phase(name, step, (step) => step.waitForEvent<T>(name, options), undefined, "workflow.wait");

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

type ChatResult = { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };

/**
 * A gen_ai span for one chat call. gemma-4 answers in the OpenAI `choices` shape, but the SDK reads chat output only
 * from `response`, so this span records the answer and the SDK's own span is suppressed.
 */
export const chatSpan = <T extends ChatResult>(model: string, inputs: { max_tokens?: number; messages: unknown[] }, fn: () => Promise<T>) =>
  Sentry.startSpan(
    {
      name: `chat ${model}`,
      op: "gen_ai.chat",
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "cloudflare.workers_ai",
        "gen_ai.request.model": model,
        "gen_ai.request.max_tokens": inputs.max_tokens,
        "gen_ai.input.messages": JSON.stringify(inputs.messages),
      },
    },
    async (span) => {
      const result = await Sentry.suppressTracing(fn);
      const input = result?.usage?.prompt_tokens ?? 0;
      const output = result?.usage?.completion_tokens ?? 0;
      span.setAttributes({ "gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": output, "gen_ai.usage.total_tokens": input + output });
      const choice = result?.choices?.[0];
      if (typeof choice?.message?.content === "string") {
        span.setAttribute("gen_ai.output.messages", JSON.stringify([
          { role: "assistant", parts: [{ type: "text", content: choice.message.content }], finish_reason: choice.finish_reason },
        ]));
      }
      return result;
    },
  );

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
