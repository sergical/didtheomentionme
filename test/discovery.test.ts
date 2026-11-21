import { afterEach, expect, mock, test } from "bun:test";
import type { Env } from "../src/env";
import { d1, migrated } from "./d1";

mock.module("@cloudflare/containers", () => ({ Container: class {}, ContainerProxy: class {}, getContainer: () => ({}) }));
const { discoverRss } = await import("../src/videos");
const { runApp } = await import("../src/runtime");

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const feed = `<feed><entry><yt:videoId>abc</yt:videoId><title>A video</title><published>2026-11-01T00:00:00Z</published></entry></feed>`;

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
