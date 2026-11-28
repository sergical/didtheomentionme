import { afterEach, expect, mock, test } from "bun:test";
import type { Env } from "../src/env";
import { d1, migrated } from "./d1";
import { DSN, captureOtlp, settle } from "./harness";

mock.module("@cloudflare/containers", () => ({ Container: class {}, ContainerProxy: class {}, getContainer: () => ({}) }));

const { FEED_DOWN_MS, discoverRss } = await import("../src/videos");
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

test("a creator whose feeds all fail is down only after 6 hours of failures", async () => {
  globalThis.fetch = (async () => new Response("Too Many Requests", { status: 429 })) as unknown as typeof fetch;
  const db = migrated();
  const env = { DB: d1(db) } as unknown as Env;
  const source = { id: "theo", youtubeChannelIds: ["a", "b"] } as never;

  // A short run of 429s is a warning, not a failure.
  expect(await runApp(env, discoverRss(source))).toBe(0);
  expect(await runApp(env, discoverRss(source))).toBe(0);
  // The first failure's time is kept, so the streak can grow past 6 hours.
  const longAgo = new Date(Date.now() - FEED_DOWN_MS - 60_000).toISOString();
  db.query("UPDATE feed_status SET failing_since = ?").run(longAgo);
  await expect(runApp(env, discoverRss(source))).rejects.toThrow(": 429");
  expect(db.query("SELECT channel_id, failing_since = ? AS kept FROM feed_status ORDER BY channel_id").all(longAgo)).toEqual([{ channel_id: "a", kept: 1 }, { channel_id: "b", kept: 1 }]);
});

test("one feed that answers ends the down streak", async () => {
  const db = migrated();
  const env = { DB: d1(db) } as unknown as Env;
  const source = { id: "theo", youtubeChannelIds: ["a", "b"] } as never;
  db.query("INSERT INTO feed_status (channel_id, failing_since) VALUES ('a', ?), ('b', ?)").run(new Date(0).toISOString(), new Date(0).toISOString());
  globalThis.fetch = (async (url: string) => (url.includes("channel_id=b") ? new Response(feed) : new Response("", { status: 429 }))) as unknown as typeof fetch;

  expect(await runApp(env, discoverRss(source))).toBe(1);
  expect(db.query("SELECT channel_id, failing_since IS NULL AS ok FROM feed_status ORDER BY channel_id").all()).toEqual([{ channel_id: "a", ok: 0 }, { channel_id: "b", ok: 1 }]);
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
  const inserts = sent.spans.filter((s) => String(s.attributes["db.query.text"]).includes("INSERT INTO videos"));
  expect(inserts.map((s) => s.name)).toEqual(["D1 batch"]);
  expect(db.query("SELECT id, status FROM videos ORDER BY id").all()).toEqual([
    { id: "a1", status: "pending" }, { id: "a2", status: "done" }, { id: "a3", status: "pending" }, { id: "a4", status: "pending" }, { id: "a5", status: "pending" },
  ]);
});

test("a database failure is not a feed failure, so it fails discovery at once", async () => {
  globalThis.fetch = (async () => new Response(feed)) as unknown as typeof fetch;
  const db = migrated();
  const binding = d1(db);
  binding.batch = async () => {
    throw new Error("D1 insert failed");
  };

  const source = { id: "theo", youtubeChannelIds: ["up"] } as never;
  await expect(runApp({ DB: binding } as unknown as Env, discoverRss(source))).rejects.toThrow("D1 insert failed");
  expect(db.query("SELECT * FROM feed_status").all()).toEqual([]);
});
