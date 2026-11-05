import { getContainer } from "@cloudflare/containers";
import { logger, metrics } from "@sentry/cloudflare";
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

/** One row per workflow instance. `videos.error` is cleared by the next success; these rows are not. */
export async function startRun(env: Env, videoId: string, instanceId: string): Promise<void> {
  await env.DB.prepare("INSERT INTO video_runs (instance_id, video_id, started_at) VALUES (?, ?, ?) ON CONFLICT(instance_id) DO NOTHING")
    .bind(instanceId, videoId, now())
    .run();
}

export async function endRun(env: Env, instanceId: string, outcome: string, reason: string | null = null): Promise<void> {
  await env.DB.prepare("UPDATE video_runs SET outcome = ?, reason = ?, ended_at = ? WHERE instance_id = ? AND ended_at IS NULL")
    .bind(outcome, reason, now(), instanceId)
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
      logger.error(logger.fmt`RSS feed of channel ${channelId} failed`, { "video.source": source.id, error: String((err as Error)?.message ?? err) });
    }
  }
  if (failures > 0 && failures === source.youtubeChannelIds.length) throw lastError;
  metrics.count("videos.discovered", inserted, { attributes: { "video.source": source.id } });
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
const NO_FINAL_STATUS = "workflow ended without a final status";
/** How long an open run without a workflow instance counts as a start that is still creating it. */
const CLAIM_LEASE_MS = 10 * 60_000;

/**
 * Workflows deletes finished instances after its retention period and then accepts their ids again. The Sentry
 * trace id comes from the instance id, so every run gets a new id and `video_runs` keeps the history.
 */
function newInstanceId(videoId: string): string {
  // Instance ids cannot start with "-", but YouTube ids can.
  const base = videoId.startsWith("-") ? `v${videoId}` : videoId;
  return `${base}_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
}

/**
 * Whether the open run of a video can still write a final status. A run that cannot is closed here, by its own
 * id, so a concurrent start that has just written a new run is never closed by mistake.
 */
async function runActive(env: Env, videoId: string): Promise<boolean> {
  const run = await env.DB.prepare("SELECT instance_id, started_at FROM video_runs WHERE video_id = ? AND ended_at IS NULL")
    .bind(videoId)
    .first<{ instance_id: string; started_at: string }>();
  if (!run) return false;
  const instance = await env.VIDEO_WORKFLOW.get(run.instance_id).catch((err) => {
    if (String((err as Error)?.message).includes("instance.not_found")) return null;
    throw err;
  });
  if (instance && !FINISHED.has((await instance.status()).status)) return true;
  if (!instance && Date.now() - Date.parse(run.started_at) < CLAIM_LEASE_MS) return true;
  await endRun(env, run.instance_id, "error", NO_FINAL_STATUS);
  return false;
}

export async function startWorkflow(env: Env, videoId: string, source: string): Promise<"started" | "running"> {
  if (await runActive(env, videoId)) return "running";
  const id = newInstanceId(videoId);
  // The open run row is the lock: a start writes it before it creates the instance, and only one can be open.
  const claim = await env.DB.prepare(
    `INSERT INTO video_runs (instance_id, video_id, started_at) SELECT ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM video_runs WHERE video_id = ? AND ended_at IS NULL)`,
  )
    .bind(id, videoId, now(), videoId)
    .run();
  if (!claim.meta.changes) return "running";
  try {
    await step("start workflow", () => env.VIDEO_WORKFLOW.create({ id, params: { videoId, source } }), {
      "video.id": videoId,
      "workflow.instance_id": id,
      "workflow.trace_id": await workflowTraceId(id),
    });
  } catch (err) {
    await endRun(env, id, "error", `workflow start failed: ${String((err as Error)?.message ?? err).slice(0, 400)}`);
    throw err;
  }
  return "started";
}

/** Frees the slot of a 'processing' video whose workflow is gone or finished without writing a final status. */
export async function reconcileProcessing(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM videos WHERE status = 'processing'").all<{ id: string }>();
  for (const row of results) {
    try {
      // runActive closes the run first, because the video update removes the row from the next SELECT.
      if (await runActive(env, row.id)) continue;
      // The workflow can write its final status after the SELECT above, so only a row still 'processing' changes.
      await env.DB.prepare("UPDATE videos SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
        .bind(NO_FINAL_STATUS, now(), row.id)
        .run();
    } catch (err) {
      logger.error(logger.fmt`Could not free the slot of video ${row.id}`, { "video.id": row.id, error: String((err as Error)?.message ?? err) });
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
