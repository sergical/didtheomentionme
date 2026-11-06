import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Env } from "../src/env";
import { exploreData, renderExplore, type ExploreSort } from "../src/explore";
import { normalizeHandle } from "../src/pipeline";
import { d1, migrated } from "./d1";

let db: Database;

const theo = { id: "theo", name: "Theo", avatar: "/theo.png", hue: 350, coverage: { videos: 2, from: "2026-09-01", to: "2026-10-01" } };
const prime = { id: "prime", name: "Prime", avatar: "/prime.png", hue: 55, coverage: { videos: 1, from: "2026-09-01", to: "2026-09-01" } };

function video(id: string, source: string, published: string, duration = 1000, status = "done") {
  db.query("INSERT INTO videos (id, source, title, published_at, duration, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, source, `Title of ${id}`, published, duration, status, published);
}

let nextId = 1;
function mention(videoId: string, handle: string, firstSeen: number, lastSeen = firstSeen + 2, quote: string | null = null) {
  db.query(
    `INSERT INTO mentions (id, video_id, detector, handle, handle_norm, text, first_seen, last_seen, frame_second, read_aloud_at, quote)
     VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(nextId++, videoId, handle, normalizeHandle(handle), `post by ${handle}`, firstSeen, lastSeen, firstSeen, quote ? firstSeen : null, quote);
}

const explore = (sort: ExploreSort = "newest") => exploreData({ DB: d1(db) } as unknown as Env, theo, [theo, prime], sort);

beforeEach(() => {
  db = migrated();
  nextId = 1;
  video("old", "theo", "2026-09-01");
  video("new", "theo", "2026-10-01");
  video("empty", "theo", "2026-09-15");
  video("skipped", "theo", "2026-10-02", 1000, "skipped");
  video("p1", "prime", "2026-09-01");
  mention("old", "@dev", 50);
  mention("old", "@dev", 1050, 1200, "post by <dev>");
  mention("old", "@ThePrimeagen", 120);
  mention("new", "@dev", 500);
  mention("skipped", "@dev", 10);
  mention("p1", "@theo", 10);
  mention("p1", "@Theo", 20);
});

describe("exploreData", () => {
  test("an unknown handle counts as a post but not as an account", async () => {
    mention("new", "@unknown", 700);
    const data = await explore();
    expect(data.totals.shown).toBe(5);
    expect(data.accounts.map((a) => a.handle)).toEqual(["@dev", "@ThePrimeagen"]);
    expect(data.videos.find((v) => v.id === "new")!.accounts.map((a) => a.handle)).toEqual(["@dev"]);
  });

  test("counts only done videos of the creator", async () => {
    const data = await explore();
    expect(data.totals).toEqual({ videos: 3, seconds: 3000, from: "2026-09-01", to: "2026-10-01", shown: 4, aloud: 1 });
    expect(data.accounts.map((a) => [a.handle, a.shown, a.videos, a.aloud])).toEqual([["@dev", 3, 2, 1], ["@ThePrimeagen", 1, 1, 0]]);
    expect(data.position).toEqual([1, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test("a post seen past the end of a video goes in the last bin", async () => {
    const { position } = await explore();
    expect(position[9]).toBe(1);
    expect(position.reduce((a, b) => a + b)).toBe(4);
  });

  test("crossovers count both directions without case", async () => {
    const { crossovers } = await explore();
    expect(crossovers).toEqual([{ other: { id: "prime", name: "Prime", xHandle: "ThePrimeagen" }, showed: 1, shownBy: 2 }]);
  });

  test("sorts videos by date or by posts, and keeps a video with no posts", async () => {
    expect((await explore()).videos.map((v) => [v.id, v.shown])).toEqual([["new", 1], ["empty", 0], ["old", 3]]);
    expect((await explore("posts")).videos.map((v) => v.id)).toEqual(["old", "new", "empty"]);
  });
});

describe("renderExplore", () => {
  test("escapes post text and quotes, and says when a video has no posts", async () => {
    const html = renderExplore(await explore());
    expect(html).toContain("post by &lt;dev&gt;");
    expect(html).not.toContain("<dev>");
    expect(html).toContain("On screen for 3 min from");
    expect(html).toContain("No X posts found on screen.");
    expect(html).toContain('href="/explore?source=theo&amp;sort=posts#videos"');
    expect(html).toContain("Theo showed <a");
  });
});
