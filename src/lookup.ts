import { logger, metrics } from "@sentry/cloudflare";
import { embed } from "./ai";
import { getSource } from "./config";
import type { Env } from "./env";
import { overlap, sameHandle, sameLongPost, samePost, tokenize } from "./pipeline";
import { step } from "./telemetry";
import { fetchTweet, parseTweetId, type TweetInfo } from "./tweet";

export interface LookupInput {
  handle: string;
  tweet: string;
  /** Words from the post. A text search ignores `handle` and `tweet`. */
  q?: string;
  source?: string | null;
}

export interface Match {
  videoId: string;
  title: string | null;
  publishedAt: string | null;
  handle: string;
  displayName: string | null;
  text: string;
  firstSeen: number;
  lastSeen: number;
  /** First-seen second of each time the post was on screen in this video. */
  times: number[];
  frameUrl: string;
  exact: boolean;
  readAloud: { at: number; quote: string; reading: Reading } | null;
  /** Text search only: share of the query words in `text`. */
  overlap?: number;
}

export interface LookupResult {
  source: { id: string; name: string };
  /** Null for a text search. */
  handle: string | null;
  query?: string;
  coverage: { videos: number; from: string | null; to: string | null };
  tweet?: TweetInfo;
  tweetError?: string;
  matches: Match[];
}

/** How much of the post a quote reads out. "comment" means the speaker only talked about the post. */
export type Reading = "all" | "part" | "comment";

/** Bad user input; the message is safe to show. */
export class LookupError extends Error {}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const VECTOR_MIN_SCORE = 0.8;
// The index holds every creator, so the query asks for many candidates and D1 filters them by creator.
// D1 binds at most 100 values per query, and findMentions binds these ids together with the word hits.
const VECTOR_TOP_K = 50;
const FTS_WORDS = 12;
const FTS_MIN_OVERLAP = 0.5;
const MIN_QUERY_WORDS = 2;
// Below this share of quote words in the post, a quote is a lead-in or a comment, such as "Back to what Zig said here."
const READ_MIN_OVERLAP = 0.4;
const READ_ALL_COVERAGE = 0.6;

interface Row {
  id: number;
  video_id: string;
  handle: string;
  handle_norm: string;
  display_name: string | null;
  text: string;
  first_seen: number;
  last_seen: number;
  frame_second: number;
  read_aloud_at: number | null;
  quote: string | null;
  title: string | null;
  published_at: string | null;
}

async function vectorMatches(env: Env, sourceId: string, text: string): Promise<number[]> {
  const [vector] = await embed(env, [text]);
  const { matches } = await step("vectorize.query", () => env.POSTS.query(vector, { topK: VECTOR_TOP_K }), { topK: VECTOR_TOP_K });
  // Vector ids are `<videoId>:<mentionId>`.
  const claimed = matches
    .filter((m) => m.score >= VECTOR_MIN_SCORE)
    .map((m) => m.id.split(":"))
    .map(([videoId, mentionId]) => ({ id: Number(mentionId), videoId }))
    .filter((c) => Number.isFinite(c.id));
  if (claimed.length === 0) return [];
  // SQLite can reuse the id of a deleted mention, so a stale vector may point at another video's row.
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.video_id FROM mentions m JOIN videos v ON v.id = m.video_id
     WHERE v.source = ? AND m.id IN (${claimed.map(() => "?").join(",")})`,
  )
    .bind(sourceId, ...claimed.map((c) => c.id))
    .all<{ id: number; video_id: string }>();
  const videoOf = new Map(results.map((r) => [r.id, r.video_id]));
  return claimed.filter((c) => videoOf.get(c.id) === c.videoId).map((c) => c.id);
}

const queryTokens = (text: string) => {
  const words = text.replace(/https?:\/\/\S+/g, " ").split(/\s+/).filter(Boolean).slice(0, FTS_WORDS);
  return [...new Set(words.flatMap(tokenize))];
};

async function ftsMatches(env: Env, sourceId: string, text: string): Promise<number[]> {
  const tokens = queryTokens(text);
  if (tokens.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.text FROM mentions_fts JOIN mentions m ON m.id = mentions_fts.rowid JOIN videos v ON v.id = m.video_id
     WHERE mentions_fts MATCH ? AND v.source = ? ORDER BY mentions_fts.rank LIMIT 20`,
  )
    .bind(tokens.map((t) => `"${t}"`).join(" OR "), sourceId)
    .all<{ id: number; text: string }>();
  return results.filter((r) => overlap(tokens, r.text) >= FTS_MIN_OVERLAP).map((r) => r.id);
}

/** Mention ids whose text is like `text`, by meaning (Vectorize) or by shared words (FTS). */
async function textMatches(env: Env, sourceId: string, text: string, embedText: string): Promise<Set<number>> {
  const found = await Promise.all([
    step("search by meaning", () => vectorMatches(env, sourceId, embedText)).catch((err) => {
      logger.error("Vector search failed, so the lookup uses word search only", { error: String(err?.message ?? err) });
      return [];
    }),
    step("search by words", () => ftsMatches(env, sourceId, text)),
  ]);
  return new Set(found.flat());
}

// x.com/i/status/<id> links have no handle.
const PROFILE_URL = /(?:x|twitter)\.com\/@?(?!i\/)([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i;

/** The handle from "@name", "name" or a profile or post URL. */
export const parseHandle = (raw: string) => {
  const value = raw.trim();
  return value.match(PROFILE_URL)?.[1] ?? value.replace(/^@/, "");
};

/** One post shown more than once in a video becomes one match with several times. */
export function mergeRepeats(matches: Match[]): Match[] {
  const merged: Match[] = [];
  for (const m of [...matches].sort((a, b) => a.firstSeen - b.firstSeen)) {
    const same = merged.find((x) => x.videoId === m.videoId && sameHandle(x.handle.toLowerCase(), m.handle.toLowerCase()) && samePost(x.text, m.text));
    if (!same) {
      merged.push({ ...m, times: [...m.times] });
      continue;
    }
    same.times.push(...m.times);
    same.exact ||= m.exact;
    same.readAloud ??= m.readAloud;
    if (m.text.length > same.text.length) same.text = m.text;
  }
  return merged;
}

// Short words like "a" and "of" are in almost every post, so they count only in a text that has no other words.
function contentWords(text: string): string[] {
  const words = [...new Set(tokenize(text))];
  const long = words.filter((t) => t.length > 2);
  return long.length ? long : words;
}

const quoteScore = (quote: string, post: string) => overlap(contentWords(quote), post);
const postCoverage = (quote: string, post: string) => overlap(contentWords(post), quote);

export function reading(quote: string, post: string): Reading {
  if (quoteScore(quote, post) < READ_MIN_OVERLAP) return "comment";
  return postCoverage(quote, post) >= READ_ALL_COVERAGE ? "all" : "part";
}

/** A reading beats a comment, then a reading of more of the post wins, then the earlier one. */
function rank({ at, quote }: { at: number; quote: string }, post: string): number[] {
  const score = quoteScore(quote, post);
  return [score >= READ_MIN_OVERLAP ? 1 : 0, postCoverage(quote, post), score, -at];
}

const outranks = (a: number[], b: number[]) => {
  const i = a.findIndex((x, j) => x !== b[j]);
  return i >= 0 && a[i] > b[i];
};

interface Quoted {
  video_id: string;
  text: string;
  read_aloud_at: number;
  quote: string;
}

/**
 * The pipeline can store one post twice, once under a misread handle, and put the real reading on the other row.
 * So each match takes the quote from the same post in the same video that reads most of the post's words.
 */
export function bestReadings(matches: Match[], quoted: Quoted[]): Match[] {
  return matches.map((m) => {
    const candidates = quoted
      .filter((r) => r.video_id === m.videoId && (r.text === m.text || sameLongPost(r.text, m.text)))
      .map((r) => ({ at: r.read_aloud_at, quote: r.quote }));
    if (m.readAloud) candidates.push(m.readAloud);
    if (candidates.length === 0) return m;
    const best = candidates.reduce((a, b) => (outranks(rank(b, m.text), rank(a, m.text)) ? b : a));
    return { ...m, readAloud: { at: best.at, quote: best.quote, reading: reading(best.quote, m.text) } };
  });
}

async function quotedIn(env: Env, videoIds: string[]): Promise<Quoted[]> {
  if (videoIds.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT video_id, text, read_aloud_at, quote FROM mentions
     WHERE quote IS NOT NULL AND read_aloud_at IS NOT NULL AND video_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify([...new Set(videoIds)]))
    .all<Quoted>();
  return results;
}

/** One match per post, each with its best reading. */
async function toMatches(env: Env, rows: Row[], exact: (r: Row) => boolean): Promise<Match[]> {
  const merged = mergeRepeats(rows.map((r) => toMatch(r, exact(r))));
  return bestReadings(merged, await quotedIn(env, merged.map((m) => m.videoId)));
}

const newestFirst = (a: Match, b: Match) =>
  (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.firstSeen - b.firstSeen;

export async function lookup(env: Env, input: LookupInput): Promise<LookupResult> {
  const kind = input.q?.trim() ? "text" : input.tweet.trim() ? "post" : "handle";
  const result = await step("lookup", () => search(env, input), { "lookup.kind": kind, "lookup.source": input.source ?? "" });
  metrics.count("lookup", 1, {
    attributes: { "lookup.kind": kind, "lookup.source": result.source.id, "lookup.result": result.matches.length ? "found" : "none" },
  });
  return result;
}

async function search(env: Env, input: LookupInput): Promise<LookupResult> {
  const source = getSource(input.source);
  if (!source) throw new LookupError("Unknown source.");

  const query = input.q?.trim().replace(/\s+/g, " ");
  if (query) {
    const tokens = queryTokens(query);
    if (tokens.length < MIN_QUERY_WORDS) throw new LookupError("Enter a few words from the post.");
    const ids = await textMatches(env, source.id, query, query);
    const matches = (await toMatches(env, await findMentions(env, source.id, { ids: [...ids] }), () => false))
      .map((m) => ({ ...m, overlap: overlap(tokens, m.text) }))
      .sort((a, b) => b.overlap - a.overlap || newestFirst(a, b));
    return { source: { id: source.id, name: source.name }, handle: null, query, coverage: await coverage(env, source.id), matches };
  }

  let tweet: TweetInfo | undefined;
  let tweetError: string | undefined;
  // People paste a post link into the handle box too.
  const tweetUrl = input.tweet.trim() || (parseTweetId(input.handle) ? input.handle : "");
  if (tweetUrl) {
    const id = parseTweetId(tweetUrl);
    if (!id) throw new LookupError("That is not an x.com or twitter.com post URL.");
    tweet = (await step("fetch post", () => fetchTweet(id), { "post.id": id })) ?? undefined;
    if (!tweet) tweetError = "Could not fetch that post, so this search uses the handle only.";
  }

  // A post URL holds the author's handle, so the search still has a handle when the fetch fails.
  const typed = parseHandle(input.handle);
  const handle = (HANDLE.test(typed) ? typed : "") || tweet?.handle || parseHandle(tweetUrl);
  if (!HANDLE.test(handle)) throw new LookupError("Enter an X handle, for example @theo.");
  const handleNorm = handle.toLowerCase();

  const textMatchIds = tweet ? await textMatches(env, source.id, tweet.text, `@${tweet.handle}: ${tweet.text}`) : new Set<number>();
  const rows = await findMentions(env, source.id, { handleNorm, ids: [...textMatchIds] });
  const matches = (await toMatches(env, rows, (r) => r.handle_norm === handleNorm && textMatchIds.has(r.id)))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || newestFirst(a, b));

  return {
    source: { id: source.id, name: source.name },
    handle,
    coverage: await coverage(env, source.id),
    tweet,
    tweetError,
    matches,
  };
}

async function findMentions(env: Env, sourceId: string, by: { handleNorm?: string; ids: number[] }): Promise<Row[]> {
  const conditions = [];
  if (by.handleNorm) conditions.push("m.handle_norm = ?");
  if (by.ids.length) conditions.push(`m.id IN (${by.ids.map(() => "?").join(",")})`);
  if (conditions.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.video_id, m.handle, m.handle_norm, m.display_name, m.text, m.first_seen, m.last_seen,
            m.frame_second, m.read_aloud_at, m.quote, v.title, v.published_at
     FROM mentions m JOIN videos v ON v.id = m.video_id
     WHERE v.source = ? AND (${conditions.join(" OR ")})`,
  )
    .bind(sourceId, ...(by.handleNorm ? [by.handleNorm] : []), ...by.ids)
    .all<Row>();
  return results;
}

export async function coverage(env: Env, sourceId: string): Promise<LookupResult["coverage"]> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS videos, MIN(published_at) AS 'from', MAX(published_at) AS 'to' FROM videos WHERE source = ? AND status = 'done'",
  )
    .bind(sourceId)
    .first<LookupResult["coverage"]>();
  return row ?? { videos: 0, from: null, to: null };
}

const toMatch = (r: Row, exact: boolean): Match => ({
  videoId: r.video_id,
  title: r.title,
  publishedAt: r.published_at,
  handle: r.handle,
  displayName: r.display_name,
  text: r.text,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  times: [r.first_seen],
  frameUrl: `/frame/${r.video_id}/${r.frame_second}.jpg`,
  exact,
  readAloud: r.read_aloud_at == null || !r.quote ? null : { at: r.read_aloud_at, quote: r.quote, reading: reading(r.quote, r.text) },
});
