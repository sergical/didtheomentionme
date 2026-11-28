import { SOURCES } from "./config";
import { Effect } from "effect";
import { span, sql, type App } from "./runtime";
import { reading, type Reading } from "./lookup";

export type ExploreSort = "newest" | "posts";

export interface LongRead {
  videoId: string;
  title: string | null;
  handle: string;
  displayName: string | null;
  quote: string;
  reading: Reading;
  readAt: number;
  firstSeen: number;
  lastSeen: number;
  frameSecond: number;
}

/** What one creator showed across every scanned video. */
export interface ExploreStats {
  xHandle: string;
  sort: ExploreSort;
  totals: { videos: number; seconds: number; from: string | null; to: string | null; shown: number; aloud: number };
  accounts: { handleNorm: string; handle: string; shown: number; aloud: number; videos: number }[];
  /** Posts first seen in each tenth of a video, from the start. */
  position: number[];
  longReads: LongRead[];
  videos: { id: string; title: string | null; publishedAt: string | null; duration: number | null; shown: number; aloud: number; accounts: { handle: string; shown: number }[] }[];
  crossovers: { other: { id: string; name: string; xHandle: string }; showed: number; shownBy: number }[];
}

type Totals = ExploreStats["totals"];

type Account = ExploreStats["accounts"][number];

type Video = ExploreStats["videos"][number];

const TOP_ACCOUNTS = 12;
const LONG_READS = 4;

// Most stored quotes are comments, not readings, so the query asks for more rows than the page shows.
const LONG_READ_CANDIDATES = 40;
const POSITION_BINS = 10;

const DONE = "JOIN videos v ON v.id = m.video_id WHERE v.source = ? AND v.status = 'done'";

/**
 * The page's numbers for one creator. The creator picker's data comes apart, so a page can run both at once instead of
 * one after the other.
 */
export const exploreData = (sourceId: string, sort: ExploreSort): Effect.Effect<ExploreStats, never, App> => Effect.gen(function* () {
  const source = { id: sourceId };
  const all = sql.all;
  const handles = SOURCES.map((s) => s.xHandle.toLowerCase());

  const [[videoTotals], [mentionTotals], accounts, bins, longReads, videos, videoAccounts, crossRows] = yield* Effect.all([
    all<Pick<Totals, "videos" | "seconds" | "from" | "to">>(
      `SELECT COUNT(*) AS videos, COALESCE(SUM(duration), 0) AS seconds, MIN(published_at) AS "from", MAX(published_at) AS "to"
       FROM videos WHERE source = ? AND status = 'done'`,
      source.id,
    ),
    all<Pick<Totals, "shown" | "aloud">>(
      `SELECT COUNT(*) AS shown, COALESCE(SUM(m.read_aloud_at IS NOT NULL), 0) AS aloud FROM mentions m ${DONE}`,
      source.id,
    ),
    all<Account>(
      `SELECT m.handle_norm AS handleNorm, MAX(m.handle) AS handle, COUNT(*) AS shown,
         SUM(m.read_aloud_at IS NOT NULL) AS aloud, COUNT(DISTINCT m.video_id) AS videos
       FROM mentions m ${DONE} AND m.handle_norm != '' GROUP BY m.handle_norm ORDER BY shown DESC, videos DESC LIMIT ?`,
      source.id, TOP_ACCOUNTS,
    ),
    all<{ bin: number; n: number }>(
      `SELECT MIN(?, CAST(? * m.first_seen / v.duration AS INTEGER)) AS bin, COUNT(*) AS n
       FROM mentions m ${DONE} AND v.duration > 0 GROUP BY bin`,
      POSITION_BINS - 1, POSITION_BINS, source.id,
    ),
    // Read aloud keeps out posts in a sidebar, which can stay on screen for a whole stream.
    all<LongRead & { text: string }>(
      `SELECT m.video_id AS videoId, v.title, m.handle, m.display_name AS displayName, m.text, m.quote, m.read_aloud_at AS readAt,
         m.first_seen AS firstSeen, m.last_seen AS lastSeen, m.frame_second AS frameSecond
       FROM mentions m ${DONE} AND m.read_aloud_at IS NOT NULL
       ORDER BY m.last_seen - m.first_seen DESC LIMIT ?`,
      source.id, LONG_READ_CANDIDATES,
    ),
    all<Omit<Video, "accounts">>(
      `SELECT v.id, v.title, v.published_at AS publishedAt, v.duration, COUNT(m.id) AS shown,
         COALESCE(SUM(m.read_aloud_at IS NOT NULL), 0) AS aloud
       FROM videos v LEFT JOIN mentions m ON m.video_id = v.id
       WHERE v.source = ? AND v.status = 'done' GROUP BY v.id
       ORDER BY ${sort === "posts" ? "shown DESC, " : ""}v.published_at DESC`,
      source.id,
    ),
    all<{ videoId: string; handle: string; shown: number }>(
      `SELECT m.video_id AS videoId, MAX(m.handle) AS handle, COUNT(*) AS shown
       FROM mentions m ${DONE} AND m.handle_norm != '' GROUP BY m.video_id, m.handle_norm ORDER BY shown DESC, handle`,
      source.id,
    ),
    all<{ source: string; handleNorm: string; n: number }>(
      `SELECT v.source, m.handle_norm AS handleNorm, COUNT(*) AS n FROM mentions m JOIN videos v ON v.id = m.video_id
       WHERE v.status = 'done' AND m.handle_norm IN (${handles.map(() => "?").join(",")}) GROUP BY v.source, m.handle_norm`,
      ...handles,
    ),
  ], { concurrency: "unbounded" });

  const byVideo = new Map<string, Video["accounts"]>();

  for (const { videoId, handle, shown } of videoAccounts) {
    const list = byVideo.get(videoId) ?? [];
    list.push({ handle, shown });
    byVideo.set(videoId, list);
  }

  const position = Array.from({ length: POSITION_BINS }, (_, i) => bins.find((b) => b.bin === i)?.n ?? 0);

  const crossCount = (from: string, handle: string) =>
    crossRows.find((r) => r.source === from && r.handleNorm === handle.toLowerCase())?.n ?? 0;

  const self = SOURCES.find((s) => s.id === source.id)!;

  const crossovers = SOURCES.filter((s) => s.id !== source.id).map((s) => ({
    other: { id: s.id, name: s.name, xHandle: s.xHandle },
    showed: crossCount(source.id, s.xHandle),
    shownBy: crossCount(s.id, self.xHandle),
  }));

  return {
    xHandle: self.xHandle,
    sort,
    totals: { ...videoTotals, ...mentionTotals },
    accounts,
    position,
    longReads: realReads(longReads),
    videos: videos.map((v) => ({ ...v, accounts: byVideo.get(v.id) ?? [] })),
    crossovers,
  };
}).pipe(span("explore data", "function", { "explore.source": sourceId, "explore.sort": sort }));

/** Readings, not comments, with one card for each frame or quote. Two rows can share both when one post was read twice. */
function realReads(rows: (LongRead & { text: string })[]): LongRead[] {
  const seen = new Set<string>();

  return rows.flatMap(({ text, ...r }) => {
    const keys = [`${r.videoId}:${r.frameSecond}`, `${r.videoId}:${r.quote}`];
    const read = reading(r.quote, text);

    if (read === "comment" || keys.some((k) => seen.has(k))) return [];
    keys.forEach((k) => seen.add(k));

    return [{ ...r, reading: read }];
  }).slice(0, LONG_READS);
}
