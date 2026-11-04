import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as Sentry from "@sentry/cloudflare";
import { frameAttributes, redactImages, sentryOptions, withFrameReference } from "../src/telemetry";
import { isExpiredFrame } from "../src/retention";

const require = createRequire(import.meta.resolve("@sentry/cloudflare"));
const { instrumentWorkersAiClient } = require("@sentry/server-utils");

describe("frame telemetry", () => {
  test("attaches references to existing concurrent AI spans and omits clef images", async () => {
    const options = sentryOptions({} as Parameters<typeof sentryOptions>[0]);
    const spans: ReturnType<typeof Sentry.spanToJSON>[] = [];
    const { initAndBind } = require("@sentry/core");
    const { ServerRuntimeClient } = require("@sentry/core/server");
    const client = initAndBind(ServerRuntimeClient, { ...options, stackParser: () => [], dsn: "https://public@example.com/1", transport: () => ({ send: async () => ({}), flush: async () => true }) });
    client.on("spanEnd", (span) => spans.push(Sentry.spanToJSON(span)));
    const ai = instrumentWorkersAiClient({ run: async () => { await Promise.resolve(); return { answers: { frame: { noul: 0.9 } } }; } });
    await Sentry.startSpan({ name: "test" }, async () => {
      await Promise.all([390, 391].map((second) => withFrameReference({ videoId: "Ka0p5tUUmgg", second, size: "f640" }, () =>
        ai.run("@cf/cloudflare/clef-flash", { state: "a post", images: [{ content_type: "image/jpeg", base64: "SECRET_IMAGE_BYTES" }], questions: { frame: { type: "noul", instructions: "is a post visible?" } } }),
      )));
    });
    const models = spans.filter((span) => span.attributes["gen_ai.request.model"]);
    expect(models).toHaveLength(2);
    expect(models.map((span) => span.attributes["app.frame.second"]).sort()).toEqual([390, 391]);
    for (const span of models) {
      expect(span.attributes["app.frame.key"]).toBe(`videos/Ka0p5tUUmgg/f640/${span.attributes["app.frame.second"]}.jpg`);
      const messages = String(span.attributes["gen_ai.input.messages"]);
      expect(messages).toContain('"type":"evaluation"');
      expect(messages).not.toContain("SECRET_IMAGE_BYTES");
      expect(messages).not.toContain("images");
    }
    await client.close();
  });

  test("replaces gemma data URLs with the exact frame URL", () => {
    const attrs = frameAttributes({ videoId: "Ka0p5tUUmgg", second: 390, size: "f1280" });
    const result = redactImages('{"url":"data:image/jpeg;base64,AAAA"}', attrs["app.frame.url"]);
    expect(JSON.parse(result).url).toBe(attrs["app.frame.url"]);
    expect(attrs["app.frame.youtube_url"]).toEndWith("&t=390s");
    expect(redactImages("data:image/jpeg;base64,AAAA", undefined)).toBe("[image/jpeg, 0 KB]");
  });
});

test("retention expires temporary images and preserves mention images", () => {
  const now = Date.now();
  const old = new Date(now - 3 * 86400000);
  expect(isExpiredFrame("videos/id/f640/390.jpg", old, now)).toBe(true);
  expect(isExpiredFrame("videos/id/f640/390.jpg", new Date(old.getTime() + 1), now)).toBe(false);
  expect(isExpiredFrame("videos/id/f1280/390.jpg", old, now)).toBe(true);
  expect(isExpiredFrame("videos/id/f1280/390.jpg", old, now, new Set(["videos/id/f1280/390.jpg"]))).toBe(false);
  expect(isExpiredFrame("videos/id/manifest.json", old, now)).toBe(false);
});
