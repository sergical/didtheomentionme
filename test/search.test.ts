import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Env } from "../src/env";
import { d1, migrated } from "./d1";

mock.module("@cloudflare/containers", () => ({ getContainer: () => ({}) }));
const { lookup } = await import("../src/lookup");
const { startPending } = await import("../src/videos");

let db: Database;
let vectorIds: string[] = [];
let started: string[] = [];

function env(): Env {
  return {
    DB: d1(db),
    AI: { run: async (_model: string, inputs: { text: string[] }) => ({ data: inputs.text.map(() => [1, 0]) }) },
    POSTS: {
      query: async (_vector: number[], { topK }: { topK: number }) => ({ matches: vectorIds.slice(0, topK).map((id) => ({ id, score: 0.95 })) }),
    },
    VIDEO_WORKFLOW: {
      get: async () => { throw new Error("not found"); },
      create: async ({ params }: { params: { videoId: string } }) => started.push(params.videoId),
    },
  } as unknown as Env;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function video(id: string, source: string, published: string, status = "done", error: string | null = null, updated = ago(0)) {
  db.query("INSERT INTO videos (id, source, title, published_at, status, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, source, id, published, status, error, updated);
}

function mention(id: number, videoId: string, handle: string, text: string) {
  db.query(
    `INSERT INTO mentions (id, video_id, detector, handle, handle_norm, text, first_seen, last_seen, frame_second)
     VALUES (?, ?, 'x', ?, ?, ?, 10, 12, 10)`,
  ).run(id, videoId, handle, handle.toLowerCase(), text);
  db.query("INSERT INTO mentions_fts (rowid, text) VALUES (?, ?)").run(id, text);
}

beforeEach(() => {
  db = migrated();
  vectorIds = [];
  started = [];
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("text search", () => {
  const crowded = () => {
    video("prime1", "prime", "2026-10-01");
    video("theo1", "theo", "2026-09-01");
    for (let i = 1; i <= 25; i++) mention(i, "prime1", "someone", "typescript generics are hard to read");
  };
  const theoOnly = (q: string) => lookup(env(), { handle: "", tweet: "", q, source: "theo" });

  test("another creator's word hits do not crowd out the requested creator", async () => {
    crowded();
    mention(100, "theo1", "dev", "typescript generics are hard to read");
    vectorIds = Array.from({ length: 25 }, (_, i) => `prime1:${i + 1}`);

    expect((await theoOnly("typescript generics are hard to read")).matches.map((m) => m.videoId)).toEqual(["theo1"]);
  });

  test("another creator's vector hits do not crowd out the requested creator", async () => {
    crowded();
    mention(100, "theo1", "dev", "generic types make code unreadable");
    vectorIds = Array.from({ length: 25 }, (_, i) => `prime1:${i + 1}`).concat("theo1:100");

    expect((await theoOnly("typescript generics are hard to read")).matches.map((m) => m.videoId)).toEqual(["theo1"]);
  });

  test("a vector whose id was reused by another video's mention is dropped", async () => {
    video("theo1", "theo", "2026-09-01");
    mention(7, "theo1", "dev", "completely different words here");
    vectorIds = ["gone1:7"];

    const result = await lookup(env(), { handle: "", tweet: "", q: "nothing shared at all", source: "theo" });
    expect(result.matches).toEqual([]);
  });
});

describe("post link in the handle field", () => {
  test("an i/status link uses the fetched author", async () => {
    video("theo1", "theo", "2026-09-01");
    mention(1, "theo1", "AuthorName", "the post text");
    globalThis.fetch = mock(async () => Response.json({ text: "the post text", user: { screen_name: "AuthorName" } })) as never;

    const result = await lookup(env(), { handle: "https://x.com/i/status/1234567890", tweet: "", source: "theo" });
    expect(result.handle).toBe("AuthorName");
    expect(result.matches[0]?.exact).toBe(true);
  });
});

describe("startPending", () => {
  test("videos sent back as not ready wait, so older ready videos start", async () => {
    video("new1", "theo", "2026-10-03", "pending", "not ready yet, will retry");
    video("new2", "theo", "2026-10-02", "pending", "not ready yet, will retry");
    video("new3", "theo", "2026-10-01", "pending", "not ready yet, will retry");
    video("old1", "theo", "2026-09-01", "pending");
    video("old2", "theo", "2026-08-01", "pending", "not ready yet, will retry", ago(31));

    expect(await startPending(env())).toBe(2);
    expect(started).toEqual(["old1", "old2"]);
  });
});
