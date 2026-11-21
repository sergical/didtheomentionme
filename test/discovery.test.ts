import { afterEach, expect, mock, test } from "bun:test";
import type { Env } from "../src/env";
import { d1, migrated } from "./d1";
import { DSN, captureOtlp, settle } from "./harness";

mock.module("@cloudflare/containers", () => ({ Container: class {}, ContainerProxy: class {}, getContainer: () => ({}) }));
const { discoverRss } = await import("../src/videos");
const { runApp } = await import("../src/runtime");

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const entry = (id: string) => `<entry><yt:videoId>${id}</yt:videoId><title>Video ${id}</title><published>2026-11-01T00:00:00Z</published></entry>`;
const feed = `<feed>${entry("abc")}</feed>`;

test("a feed whose request is rejected does not stop the next channel", async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requested.push(url);
    if (url.includes("channel_id=down")) throw new TypeError("network connection lost");
    return new Response(feed);
  }) as typeof fetch;
  const db = migrated();
  const source = { id: "theo", youtubeChannelIds: ["down", "up"] } as never;

  expect(await runApp({ DB: d1(db) } as unknown as Env, discoverRss(source))).toBe(1);
  expect(requested.map((url) => new URL(url).searchParams.get("channel_id"))).toEqual(["down", "up"]);
  expect(db.query("SELECT id, status FROM videos").all()).toEqual([{ id: "abc", status: "pending" }]);
});

test("a creator fails only when every feed fails", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("network connection lost");
  }) as unknown as typeof fetch;
  const source = { id: "theo", youtubeChannelIds: ["a", "b"] } as never;
  await expect(runApp({ DB: d1(migrated()) } as unknown as Env, discoverRss(source))).rejects.toThrow("network connection lost");
});

test("a feed's videos go into D1 in one batch, not one query each", async () => {
  const sent = captureOtlp();
  const capture = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes("youtube.com") ? new Response(`<feed>${["a1", "a2", "a3", "a4", "a5"].map(entry).join("")}</feed>`) : capture(input, init)) as typeof fetch;
  const db = migrated();
  db.query("INSERT INTO videos (id, source, status, updated_at) VALUES ('a2', 'theo', 'done', ?)").run(new Date().toISOString());
  const source = { id: "theo", youtubeChannelIds: ["up"] } as never;

  expect(await runApp({ DB: d1(db), SENTRY_DSN: DSN } as unknown as Env, discoverRss(source))).toBe(4);
  await settle(1200);
  sent.restore();
  const queries = sent.spans.filter((s) => s.attributes["sentry.op"] === "db.query");
  expect(queries.map((s) => s.name)).toEqual(["D1 batch"]);
  expect(db.query("SELECT id, status FROM videos ORDER BY id").all()).toEqual([
    { id: "a1", status: "pending" }, { id: "a2", status: "done" }, { id: "a3", status: "pending" }, { id: "a4", status: "pending" }, { id: "a5", status: "pending" },
  ]);
});
