import { getContainer } from "@cloudflare/containers";
import { MAX_IN_FLIGHT, MAX_RETRIES, MIN_DURATION_SECONDS, RETRY_BASE_MINUTES, type Source } from "./config";
import type { Env } from "./env";
import { step, workflowTraceId } from "./telemetry";

export interface VideoInfo {
  id: string;
  title: string | null;
  publishedAt: string | null;
  duration: number | null;
}

export function containerFetch(env: Env, name: string, path: string, init?: RequestInit): Promise<Response> {
  return step(`container ${init?.method ?? "GET"} ${path}`, () => getContainer(env.MEDIA, name).fetch(`http://container${path}`, init));
}

/**
 * An idle container still counts against `max_instances` until `sleepAfter`, and a running one keeps
 * its in-memory job across deploys. Destroying it frees the slot and makes the next job start fresh.
 */
export function destroyContainer(env: Env, name: string): Promise<void> {
  return step("container destroy", () => getContainer(env.MEDIA, name).destroy());
}

const now = () => new Date().toISOString();

/** Normalises dates from RSS and yt-dlp so they sort as plain strings. */
export function isoOrNull(value: string | null | undefined): string | null {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export async function setStatus(env: Env, videoId: string, status: string, error: string | null = null): Promise<void> {
  await env.DB.prepare("UPDATE videos SET status = ?, error = ?, updated_at = ? WHERE id = ?")
    .bind(status, error, now(), videoId)
    .run();
}

/** Inserts an unknown video as pending. An existing row keeps its status. */
async function insertPending(env: Env, source: string, v: VideoInfo): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO videos (id, source, title, published_at, duration, status, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(v.id, source, v.title, isoOrNull(v.publishedAt), v.duration, now())
    .run();
  return result.meta.changes > 0;
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

async function discoverChannel(env: Env, source: Source, channelId: string): Promise<number> {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`RSS ${source.id} ${channelId}: ${res.status}`);
  let inserted = 0;
  for (const entry of (await res.text()).split("<entry>").slice(1)) {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!id) continue;
    const title = entry.match(/<title>([^<]*)<\/title>/)?.[1];
    const publishedAt = entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? null;
    if (await insertPending(env, source.id, { id, title: title ? decodeXml(title) : null, publishedAt, duration: null })) inserted++;
  }
  return inserted;
}

/** One failing channel does not stop the others; it throws only when every channel failed. */
export async function discoverRss(env: Env, source: Source): Promise<number> {
  let inserted = 0;
  let failures = 0;
  let lastError: unknown;
  for (const channelId of source.youtubeChannelIds) {
    try {
      inserted += await discoverChannel(env, source, channelId);
    } catch (err) {
      failures++;
      lastError = err;
      console.error(`RSS ${source.id} ${channelId} failed`, err);
    }
  }
  if (failures > 0 && failures === source.youtubeChannelIds.length) throw lastError;
  return inserted;
}

interface ListedVideo {
  id: string;
  title?: string;
  publishedAt?: string | null;
  duration?: number | null;
  liveStatus?: string | null;
}

export async function backfill(env: Env, source: Source, days: number): Promise<{ listed: number; inserted: number }> {
  const videos: ListedVideo[] = [];
  try {
    for (const channelId of source.youtubeChannelIds) {
      const res = await containerFetch(env, "admin", "/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, limit: 80 }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`container /list: ${res.status} ${body.slice(0, 200)}`);
      videos.push(...(JSON.parse(body) as { videos: ListedVideo[] }).videos);
    }
  } finally {
    await destroyContainer(env, "admin");
  }
  const cutoff = Date.now() - days * 86_400_000;
  let inserted = 0;
  for (const v of videos) {
    const published = v.publishedAt ? Date.parse(v.publishedAt) : NaN;
    if (!(published >= cutoff)) continue;
    if (v.duration != null && v.duration < MIN_DURATION_SECONDS) continue;
    if (v.liveStatus === "is_live" || v.liveStatus === "is_upcoming") continue;
    const added = await insertPending(env, source.id, {
      id: v.id,
      title: v.title ?? null,
      publishedAt: v.publishedAt ?? null,
      duration: v.duration ?? null,
    });
    if (added) inserted++;
  }
  return { listed: videos.length, inserted };
}

const FINISHED = new Set(["complete", "errored", "terminated"]);

/**
 * Instance ids are `<videoId>`, then `<videoId>_1`, `<videoId>_2`, ... A finished instance keeps its id
 * forever, so a video that goes back to pending (not_ready, manual retry) needs the next id. Only the
 * latest instance can still be running.
 */
async function probeInstances(env: Env, videoId: string) {
  // Instance ids cannot start with "-", but YouTube ids can. "v" + 11 characters cannot clash with a real id.
  const base = videoId.startsWith("-") ? `v${videoId}` : videoId;
  const instanceId = (n: number) => (n === 0 ? base : `${base}_${n}`);
  let n = 0;
  let latest: WorkflowInstance | null = null;
  for (;;) {
    const instance = await env.VIDEO_WORKFLOW.get(instanceId(n)).catch(() => null);
    if (!instance) break;
    latest = instance;
    n++;
  }
  return { latest, nextId: instanceId(n) };
}

export async function startWorkflow(env: Env, videoId: string, source: string): Promise<"started" | "running"> {
  const { latest, nextId } = await probeInstances(env, videoId);
  if (latest && !FINISHED.has((await latest.status()).status)) return "running";
  await step("start workflow", () => env.VIDEO_WORKFLOW.create({ id: nextId, params: { videoId, source } }), {
    "video.id": videoId,
    "workflow.instance_id": nextId,
    "workflow.trace_id": await workflowTraceId(nextId),
  });
  return "started";
}

/** Frees the slot of a 'processing' video whose workflow is gone or finished without writing a final status. */
export async function reconcileProcessing(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM videos WHERE status = 'processing'").all<{ id: string }>();
  for (const row of results) {
    try {
      const { latest } = await probeInstances(env, row.id);
      if (latest && !FINISHED.has((await latest.status()).status)) continue;
      // The workflow can write its final status after the SELECT above, so only a row still 'processing' changes.
      await env.DB.prepare("UPDATE videos SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
        .bind("workflow ended without a final status", now(), row.id)
        .run();
    } catch (err) {
      console.error(`reconcile ${row.id} failed`, err);
    }
  }
}

export async function processNow(env: Env, videoId: string, source: string): Promise<"started" | "running"> {
  await insertPending(env, source, { id: videoId, title: null, publishedAt: null, duration: null });
  const result = await startWorkflow(env, videoId, source);
  if (result === "started") await setStatus(env, videoId, "processing");
  return result;
}

/** Puts failed videos back in the queue. The wait before each new attempt doubles. */
async function requeueErrors(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE videos SET status = 'pending', attempts = attempts + 1
     WHERE status = 'error' AND attempts < ?
       AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (? << attempts) || ' minutes')`,
  )
    .bind(MAX_RETRIES, RETRY_BASE_MINUTES)
    .run();
}

export async function startPending(env: Env): Promise<number> {
  await reconcileProcessing(env);
  await requeueErrors(env);
  const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM videos WHERE status = 'processing'").first<{ n: number }>())!;
  const slots = MAX_IN_FLIGHT - n;
  if (slots <= 0) return 0;
  // A pending video with a note came back not ready. It waits, so it cannot hold the first slots on every run.
  const { results } = await env.DB.prepare(
    `SELECT id, source FROM videos WHERE status = 'pending'
       AND (error IS NULL OR updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' minutes'))
     ORDER BY published_at DESC LIMIT ?`,
  )
    .bind(RETRY_BASE_MINUTES, slots * 3)
    .all<{ id: string; source: string }>();
  let started = 0;
  for (const row of results) {
    if (started >= slots) break;
    try {
      if ((await startWorkflow(env, row.id, row.source)) === "started") {
        await setStatus(env, row.id, "processing");
        started++;
      }
    } catch (err) {
      await setStatus(env, row.id, "error", `workflow start failed: ${String((err as Error)?.message ?? err).slice(0, 400)}`);
    }
  }
  return started;
}
