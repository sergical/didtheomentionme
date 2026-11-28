import { getContainer } from "@cloudflare/containers";
import { Cause, Effect, Exit, Option, Result, Schema } from "effect";
import { MAX_IN_FLIGHT, MAX_RETRIES, MIN_DURATION_SECONDS, RETRY_BASE_MINUTES, type Source } from "./config";
import { Bindings, annotate, d1Batch, httpFetch, span, sql, traceHeaders } from "./runtime";
import { errorMessage, workflowTraceId } from "./telemetry";

export interface VideoInfo {
  id: string;
  title: string | null;
  publishedAt: string | null;
  duration: number | null;
}

export const containerFetch = (name: string, path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const env = yield* Bindings;
    // The container's Python SDK continues the trace from these headers.
    const headers = new Headers(init?.headers);

    for (const [header, value] of Object.entries(yield* traceHeaders)) headers.set(header, value);

    return yield* Effect.promise(() => getContainer(env.MEDIA, name).fetch(`http://container${path}`, { ...init, headers }));
  }).pipe(span(`container ${init?.method ?? "GET"} ${path}`, "function"));

/**
 * An idle container still counts against `max_instances` until `sleepAfter`, and a running one keeps
 * its in-memory job across deploys. Destroying it frees the slot and makes the next job start fresh.
 */
export const destroyContainer = (name: string) =>
  Effect.flatMap(Bindings, (env) => Effect.promise(() => getContainer(env.MEDIA, name).destroy())).pipe(span("container destroy", "function"));

/** The container sends a `stopped` event to this workflow instance if it stops while the instance waits. */
export const watchContainerJob = (name: string, instanceId: string) =>
  Effect.flatMap(Bindings, (env) => Effect.promise(() => getContainer(env.MEDIA, name).watchJob(instanceId)));

const now = () => new Date().toISOString();

/** Normalises dates from RSS and yt-dlp so they sort as plain strings. */
export function isoOrNull(value: string | null | undefined): string | null {
  const t = value ? Date.parse(value) : NaN;

  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export const setStatus = (videoId: string, status: string, error: string | null = null) =>
  sql.run("UPDATE videos SET status = ?, error = ?, updated_at = ? WHERE id = ?", status, error, now(), videoId);

/** One row per workflow instance. `videos.error` is cleared by the next success; these rows are not. */
export const startRun = (videoId: string, instanceId: string) =>
  sql.run("INSERT INTO video_runs (instance_id, video_id, started_at) VALUES (?, ?, ?) ON CONFLICT(instance_id) DO NOTHING", instanceId, videoId, now());

export const endRun = (instanceId: string, outcome: string, reason: string | null = null) =>
  sql.run("UPDATE video_runs SET outcome = ?, reason = ?, ended_at = ? WHERE instance_id = ? AND ended_at IS NULL", outcome, reason, now(), instanceId);

const INSERT_PENDING = `INSERT INTO videos (id, source, title, published_at, duration, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(id) DO NOTHING`;

/**
 * Inserts unknown videos as pending, in one batch, and returns how many were new. An existing row keeps its status.
 * One INSERT per feed entry was an N+1 that Sentry flagged: about 15 to 30 sequential queries per channel.
 */
const insertPending = (source: string, videos: VideoInfo[]) =>
  Effect.map(
    d1Batch(INSERT_PENDING, videos.map((v) => [v.id, source, v.title, isoOrNull(v.publishedAt), v.duration, now()])),
    (results) => results.filter((result) => result.meta.changes > 0).length,
  );

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

/** The videos in a channel's feed. A failure here is the feed's, not the database's. */
const readFeed = (source: Source, channelId: string) =>
  Effect.gen(function* () {
    const res = yield* httpFetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);

    if (!res.ok) return yield* Effect.fail(new Error(`RSS ${source.id} ${channelId}: ${res.status}`));
    const videos: VideoInfo[] = [];

    for (const entry of (yield* Effect.promise(() => res.text())).split("<entry>").slice(1)) {
      const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];

      if (!id) continue;
      const title = entry.match(/<title>([^<]*)<\/title>/)?.[1];
      const publishedAt = entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? null;
      videos.push({ id, title: title ? decodeXml(title) : null, publishedAt, duration: null });
    }

    return videos;
  });

/** A feed that fails for this long is down, not rate limited, and becomes an Issue. */
export const FEED_DOWN_MS = 6 * 3_600_000;

const feedOk = (channelId: string) =>
  sql.run(
    `INSERT INTO feed_status (channel_id, last_ok_at, failing_since, last_error) VALUES (?, ?, NULL, NULL)
     ON CONFLICT(channel_id) DO UPDATE SET last_ok_at = excluded.last_ok_at, failing_since = NULL, last_error = NULL`,
    channelId, now(),
  );

/** Records a failure, and returns since when the feed has failed without a success. */
const feedFailed = (channelId: string, error: string) =>
  Effect.gen(function* () {
    yield* sql.run(
      `INSERT INTO feed_status (channel_id, failing_since, last_error) VALUES (?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET failing_since = COALESCE(failing_since, excluded.failing_since), last_error = excluded.last_error`,
      channelId, now(), error,
    );
    const row = yield* sql.first<{ failing_since: string }>("SELECT failing_since FROM feed_status WHERE channel_id = ?", channelId);

    return Date.parse(row?.failing_since ?? now());
  });

/**
 * One failing channel does not stop the others. It fails only when every channel has failed for `FEED_DOWN_MS`:
 * YouTube often answers 429 to Cloudflare's addresses for a while, and that alone is no reason for an Issue.
 */
export const discoverRss = (source: Source) =>
  Effect.gen(function* () {
    let inserted = 0;
    let failures = 0;
    let lastError: unknown;
    let downSince = 0;

    for (const channelId of source.youtubeChannelIds) {
      // `exit`, so a rejected fetch, which is a defect, also moves on to the next channel. Only the feed gets the
      // grace period: a database failure below is not caught here, so it is an Issue at once.
      const exit = yield* Effect.exit(readFeed(source, channelId));

      if (Exit.isSuccess(exit)) {
        inserted += yield* insertPending(source.id, exit.value);
        yield* feedOk(channelId);
        continue;
      }

      failures++;
      lastError = Cause.squash(exit.cause);
      downSince = Math.max(downSince, yield* feedFailed(channelId, errorMessage(lastError).slice(0, 300)));
      yield* Effect.logWarning(`RSS feed of channel ${channelId} failed`).pipe(
        Effect.annotateLogs({ "video.source": source.id, "youtube.channel_id": channelId, error: errorMessage(lastError) }),
      );
    }

    yield* annotate({ "videos.discovered": inserted, "videos.failed_channels": failures });
    // `downSince` is the most recent start of a failing streak, so every channel has been down at least this long.
    const allDown = failures > 0 && failures === source.youtubeChannelIds.length;

    if (allDown && Date.now() - downSince >= FEED_DOWN_MS) return yield* Effect.fail(lastError);

    return inserted;
  }).pipe(span(`discover ${source.id}`, "function", { "video.source": source.id }));

/** One video in the answer of the container's `/list`, as `list_videos` in container/server.py writes it. */
const ListedVideo = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  publishedAt: Schema.optional(Schema.NullOr(Schema.String)),
  duration: Schema.optional(Schema.NullOr(Schema.Number)),
  liveStatus: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeListing = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ videos: Schema.Array(ListedVideo) })));

export const backfill = (source: Source, days: number) =>
  Effect.gen(function* () {
    const videos: (typeof ListedVideo.Type)[] = [];

    for (const channelId of source.youtubeChannelIds) {
      const res = yield* containerFetch("admin", "/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, limit: 80 }),
      });

      const body = yield* Effect.promise(() => res.text());

      if (!res.ok) return yield* Effect.fail(new Error(`container /list: ${res.status} ${body.slice(0, 200)}`));
      const listing = Option.getOrNull(decodeListing(body));

      if (!listing) return yield* Effect.fail(new Error(`container /list answered something else than videos: ${body.slice(0, 200)}`));
      videos.push(...listing.videos);
    }

    const cutoff = Date.now() - days * 86_400_000;

    const wanted = videos.filter((v) => {
      const published = v.publishedAt ? Date.parse(v.publishedAt) : NaN;

      return published >= cutoff && !(v.duration != null && v.duration < MIN_DURATION_SECONDS) && v.liveStatus !== "is_live" && v.liveStatus !== "is_upcoming";
    });

    const inserted = yield* insertPending(source.id, wanted.map((v) => ({ id: v.id, title: v.title ?? null, publishedAt: v.publishedAt ?? null, duration: v.duration ?? null })));

    return { listed: videos.length, inserted };
  }).pipe(Effect.ensuring(Effect.orDie(destroyContainer("admin"))), span("backfill", "function", { "video.source": source.id, days }));

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
const runActive = (videoId: string) =>
  Effect.gen(function* () {
    const env = yield* Bindings;
    const run = yield* sql.first<{ instance_id: string; started_at: string }>("SELECT instance_id, started_at FROM video_runs WHERE video_id = ? AND ended_at IS NULL", videoId);

    if (!run) return false;

    const instance = yield* Effect.promise(() => env.VIDEO_WORKFLOW.get(run.instance_id).catch((err) => {
      if (errorMessage(err).includes("instance.not_found")) return null;
      throw err;
    }));

    if (instance && !FINISHED.has((yield* Effect.promise(() => instance.status())).status)) return true;

    if (!instance && Date.now() - Date.parse(run.started_at) < CLAIM_LEASE_MS) return true;
    yield* endRun(run.instance_id, "error", NO_FINAL_STATUS);

    return false;
  });

export const startWorkflow = (videoId: string, source: string) =>
  Effect.gen(function* () {
    const env = yield* Bindings;

    if (yield* runActive(videoId)) return "running" as const;
    const id = newInstanceId(videoId);

    // The open run row is the lock: a start writes it before it creates the instance, and only one can be open.
    const claim = yield* sql.run(
      `INSERT INTO video_runs (instance_id, video_id, started_at) SELECT ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM video_runs WHERE video_id = ? AND ended_at IS NULL)`,
      id, videoId, now(), videoId,
    );

    if (!claim.meta.changes) return "running" as const;
    const traceId = yield* Effect.promise(() => workflowTraceId(id));

    const started = yield* Effect.result(
      Effect.tryPromise({ try: () => env.VIDEO_WORKFLOW.create({ id, params: { videoId, source } }), catch: (err) => err })
        .pipe(span("start workflow", "function", { "video.id": videoId, "workflow.instance_id": id, "workflow.trace_id": traceId })),
    );

    if (Result.isFailure(started)) {
      yield* endRun(id, "error", `workflow start failed: ${errorMessage(started.failure).slice(0, 400)}`);

      return yield* Effect.fail(started.failure);
    }

    return "started" as const;
  });

/** Frees the slot of a 'processing' video whose workflow is gone or finished without writing a final status. */
export const reconcileProcessing = Effect.gen(function* () {
  const results = yield* sql.all<{ id: string }>("SELECT id FROM videos WHERE status = 'processing'");

  for (const row of results) {
    const freed = Effect.gen(function* () {
      // runActive closes the run first, because the video update removes the row from the next SELECT.
      if (yield* runActive(row.id)) return;
      // The workflow can write its final status after the SELECT above, so only a row still 'processing' changes.
      yield* sql.run("UPDATE videos SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'processing'", NO_FINAL_STATUS, now(), row.id);
    });

    yield* freed.pipe(Effect.catchCause((cause) =>
      Effect.logError(`Could not free the slot of video ${row.id}`).pipe(Effect.annotateLogs({ "video.id": row.id, error: errorMessage(Cause.squash(cause)) })),
    ));
  }
});

export const processNow = (videoId: string, source: string) =>
  Effect.gen(function* () {
    yield* insertPending(source, [{ id: videoId, title: null, publishedAt: null, duration: null }]);
    const result = yield* startWorkflow(videoId, source);

    if (result === "started") yield* setStatus(videoId, "processing");

    return result;
  });

/** Puts failed videos back in the queue. The wait before each new attempt doubles. */
const requeueErrors = sql.run(
  `UPDATE videos SET status = 'pending', attempts = attempts + 1
   WHERE status = 'error' AND attempts < ?
     AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (? << attempts) || ' minutes')`,
  MAX_RETRIES, RETRY_BASE_MINUTES,
);

export const startPending = Effect.gen(function* () {
  yield* reconcileProcessing;
  yield* requeueErrors;
  const { n } = (yield* sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM videos WHERE status = 'processing'"))!;
  const slots = MAX_IN_FLIGHT - n;

  if (slots <= 0) return 0;

  // A pending video with a note came back not ready. It waits, so it cannot hold the first slots on every run.
  const results = yield* sql.all<{ id: string; source: string }>(
    `SELECT id, source FROM videos WHERE status = 'pending'
       AND (error IS NULL OR updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' minutes'))
     ORDER BY published_at DESC LIMIT ?`,
    RETRY_BASE_MINUTES, slots * 3,
  );

  let started = 0;

  for (const row of results) {
    if (started >= slots) break;
    // `exit`, so a failed Workflows call, which is a defect, marks this video and the others still start.
    const exit = yield* Effect.exit(startWorkflow(row.id, row.source));

    if (Exit.isFailure(exit)) {
      yield* setStatus(row.id, "error", `workflow start failed: ${errorMessage(Cause.squash(exit.cause)).slice(0, 400)}`);
    } else if (exit.value === "started") {
      yield* setStatus(row.id, "processing");
      started++;
    }
  }

  yield* annotate({ "videos.started": started, "videos.slots": slots });

  return started;
}).pipe(span("start pending videos", "function"));
