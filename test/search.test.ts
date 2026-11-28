import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ai, env as bindings, posts, textsAsked, workflows } from "./bindings";
import { d1, migrated } from "./d1";
import { DSN, captureOtlp, replaceFetch, settle } from "./harness";

mock.module("@cloudflare/containers", () => ({ Container: class {}, ContainerProxy: class {}, getContainer: () => ({}) }));

const { lookup } = await import("../src/lookup");
const { runApp } = await import("../src/runtime");
const { startPending } = await import("../src/videos");

let db: Database;
let vectorIds: string[] = [];
let started: string[] = [];

/** The bindings of a search. Each D1 query answers after `latencyMs`. */
const env = (latencyMs = 0) =>
  bindings({
    DB: d1(db, latencyMs),
    AI: ai((_model, inputs) => ({ data: textsAsked(inputs).map(() => [1, 0]) })),
    POSTS: posts(() => vectorIds),
    VIDEO_WORKFLOW: workflows(new Map(), (_id, params) => void started.push(params.videoId)),
  });

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A video, done unless `queued` says it is pending with this note, last updated `updatedAgo` minutes ago. */
function video(id: string, source: string, published: string, queued?: { note: string | null; updatedAgo?: number }) {
  db.query("INSERT INTO videos (id, source, title, published_at, status, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, source, id, published, queued ? "pending" : "done", queued?.note ?? null, ago(queued?.updatedAgo ?? 0));
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

  const theoOnly = (q: string) => runApp(env(), lookup({ handle: "", tweet: "", q, source: "theo" }));

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

    const result = await runApp(env(), lookup({ handle: "", tweet: "", q: "nothing shared at all", source: "theo" }));
    expect(result.matches).toEqual([]);
  });
});

describe("post link in the handle field", () => {
  test("an i/status link uses the fetched author", async () => {
    video("theo1", "theo", "2026-09-01");
    mention(1, "theo1", "AuthorName", "the post text");
    replaceFetch(async () => Response.json({ text: "the post text", user: { screen_name: "AuthorName" } }));

    const result = await runApp(env(), lookup({ handle: "https://x.com/i/status/1234567890", tweet: "", source: "theo" }));
    expect(result.handle).toBe("AuthorName");
    expect(result.matches[0]?.exact).toBe(true);
  });
});

describe("startPending", () => {
  test("videos sent back as not ready wait, so older ready videos start", async () => {
    const note = "not ready yet, will retry";
    video("new1", "theo", "2026-10-03", { note });
    video("new2", "theo", "2026-10-02", { note });
    video("new3", "theo", "2026-10-01", { note });
    video("old1", "theo", "2026-09-01", { note: null });
    video("old2", "theo", "2026-08-01", { note, updatedAgo: 31 });

    expect(await runApp(env(), startPending)).toBe(2);
    expect(started).toEqual(["old1", "old2"]);
  });
});

test("a lookup counts the creator's coverage beside the search, not after it", async () => {
  video("theo1", "theo", "2026-09-01");
  mention(1, "theo1", "dev", "typescript generics are hard to read");
  const sent = captureOtlp();
  // Each query takes 30 ms, so queries that run one after another cannot overlap.
  await runApp({ ...env(30), SENTRY_DSN: DSN }, lookup({ handle: "dev", tweet: "", source: "theo" }));
  await settle(1200);
  sent.restore();

  const queries = sent.spans.filter((s) => s.attributes["sentry.op"] === "db.query");
  const coverage = queries.find((s) => String(s.attributes["db.query.text"]).startsWith("SELECT COUNT(*) AS videos"))!;
  const search = queries.filter((s) => s !== coverage);
  expect(search.length).toBeGreaterThan(0);
  // The two overlap: each starts before the other ends.
  expect(coverage.startMs).toBeLessThan(search[0].endMs);
  expect(search[0].startMs).toBeLessThan(coverage.endMs);
});
