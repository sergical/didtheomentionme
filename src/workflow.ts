import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect } from "effect";
import { detectFrame, embed, findQuote, readAloudProbability, readPosts, transcribe, type QuoteSearch } from "./ai";
import { MIN_DURATION_SECONDS, getDetector, getSource, type Detector } from "./config";
import type { Env, VideoParams } from "./env";
import {
  buildWindow,
  canonicalHandles,
  countHandles,
  frameSeconds,
  frameTimeline,
  inheritProbabilities,
  expandSentence,
  findRuns,
  groupPosts,
  pickSeconds,
  timeAtOffset,
  type Observation,
  type PostGroup,
  type Run,
  type Word,
  normalizeHandle,
  UNKNOWN_HANDLE,
  withCanonicalHandle,
} from "./pipeline";
import { EXTRACT_EVENT, JOB_PROTOCOL, UPLOAD_HOST } from "./container";
import { annotate, d1, r2, span, sql, vectorize, type App } from "./runtime";
import { Steps } from "./steps";
import { Telemetry, errorMessage, frameAttributes } from "./telemetry";
import { containerFetch, destroyContainer, endRun, isoOrNull, setStatus, startRun, watchContainerJob } from "./videos";

const DETECT_BATCH = 120;
const DETECT_CONCURRENCY = 10;
/**
 * Workers AI returned error 3021 for clef-flash with 3 steps of 12 calls and with 2 steps of 12.
 * 2 steps of 10 calls run about 1,400 calls a minute, which is at the limit: one 2,462-frame video had 3021 only in its last 15 s.
 */
const DETECT_STEPS = 2;
const READ_CONCURRENCY = 6;
/** Most runs need 1 to 5 reader calls. Qwen answered 142 frames at 10 calls at a time with no error 3021. */
const READ_RUNS = 3;
const READ_ALOUD_CONCURRENCY = 4;
const READ_ALOUD_SLICES = 3;
const WINDOW_PADDING_SECONDS = 30;
const AUDIO_CHUNK_SECONDS = 600;
const EXTRACT_WAIT = "30 minutes";
const MAX_EXTRACT_WAITS = 3;
const EMBED_BATCH = 50;

const IO_STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
/** Waits out "Maximum number of running container instances exceeded" while other videos finish, and a container rollout. */
const START_STEP = { retries: { limit: 8, delay: "30 seconds", backoff: "linear" }, timeout: "5 minutes" } as const;
const AI_STEP = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "15 minutes" } as const;

type Manifest = {
  videoId: string;
  title: string | null;
  duration: number | null;
  publishedAt: string | null;
  frames: number;
  keptSeconds?: number[];
  hasCaptions: boolean;
  captionsError?: string | null;
  audioChunks: number | string[];
};

type JobStatus = {
  state: "running" | "done" | "error" | "stopped";
  stage: string | null;
  restarted?: boolean;
  uploaded?: number;
  total?: number;
  error: string | null;
  manifest: Manifest | null;
};

type Mention = PostGroup & {
  detector: string;
  readAloudP: number | null;
  readAloudAt: number | null;
  quote: string | null;
};

type ReadAloudResult = "read" | "not_read" | "no_quote" | "no_transcript";

const key = (videoId: string, path: string) => `videos/${videoId}/${path}`;
const transcriptKey = (videoId: string) => `transcripts/${videoId}.json`;

/** One video run. */
export class VideoPipeline extends WorkflowEntrypoint<Env, VideoParams> {
  async run(event: WorkflowEvent<VideoParams>, step: WorkflowStep): Promise<void> {
    const { videoId, source } = event.payload;
    const { instanceId } = event;
    const steps = await Steps.start(this.env, step, instanceId);
    const run = { "video.id": videoId, "video.source": source, "workflow.instance_id": instanceId };
    // The run span's start, from the first step. A run whose first step fails still gets a span from mark-error.
    let startMs = Date.now();
    try {
      startMs = await steps.do("mark-processing", IO_STEP, Effect.gen(function* () {
        yield* startRun(videoId, instanceId);
        yield* setStatus(videoId, "processing");
        return Date.now();
      }));
      const { outcome, facts } = await this.process(videoId, source, instanceId, steps);
      const pending = outcome === "not_ready";
      await steps.do("mark-final", IO_STEP, Effect.gen(function* () {
        // endRun writes once, so it goes last: a failed status write must leave the run open for mark-error.
        yield* setStatus(videoId, pending ? "pending" : outcome, pending ? "not ready yet, will retry" : null);
        yield* endRun(instanceId, outcome);
        if (pending) yield* Effect.logWarning(`${videoId} not ready: ${outcome}`).pipe(Effect.annotateLogs(run));
        yield* Effect.logInfo(`Video ${videoId} finished: ${outcome}`).pipe(Effect.annotateLogs(run));
        yield* steps.recordRun(`video ${videoId}`, startMs, false, { ...run, ...facts, "video.outcome": outcome });
      }));
    } catch (err) {
      const message = errorMessage(err).slice(0, 500);
      await steps.do("mark-error", IO_STEP, Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        yield* endRun(instanceId, "error", message);
        yield* setStatus(videoId, "error", message);
        yield* telemetry.reportError(err, run);
        yield* Effect.logError(`Video ${videoId} failed: ${message}`).pipe(Effect.annotateLogs(run));
        yield* steps.recordRun(`video ${videoId}`, startMs, true, { ...run, "video.outcome": "error", "video.error": message });
      }));
      throw err;
    }
  }

  private async process(videoId: string, sourceId: string, instanceId: string, steps: Steps): Promise<{ outcome: "done" | "skipped" | "not_ready"; facts: Record<string, number | string | boolean> }> {
    const config = getSource(sourceId);
    if (!config) throw new NonRetryableError(`unknown source ${sourceId}`);
    const detectors = config.detectors.map(getDetector);

    const manifest = await steps.phase("extract", (steps) => this.extract(videoId, instanceId, steps));
    if (typeof manifest === "string") return { outcome: manifest, facts: {} };

    const isShort = manifest.duration != null && manifest.duration < MIN_DURATION_SECONDS;
    const mentions: Mention[] = [];
    const timeline = frameTimeline(manifest.frames, manifest.keptSeconds);

    const origin = manifest.hasCaptions ? "captions" : "whisper";
    const words = await steps.phase("transcribe", async (steps) => {
      if (!isShort && !manifest.hasCaptions) await this.transcribeAudio(videoId, audioChunkCount(manifest), steps);
      return steps.do("keep-transcript", IO_STEP, keepTranscript(videoId, origin));
    }, { "app.transcript_origin": origin });

    if (!isShort) {
      for (const detector of detectors) {
        const attributes = { "app.detector": detector.id };
        const probs = await steps.phase("detect", (steps) => this.detect(videoId, detector, manifest, timeline, steps), attributes);
        await steps.phase("read", async (steps) => {
          const runs = findRuns(probs, detector.frameThreshold);
          const found: Mention[][] = runs.map(() => []);
          await pool(runs, READ_RUNS, async (run, i) => {
            const posts = await steps.do(`read-${detector.id}-${run.start}`, AI_STEP, readRun(videoId, detector, run, timeline), { "app.run.start": run.start, "app.run.end": run.end });
            if (posts.length === 0) return;
            const withAloud = await steps.do(`read-aloud-${detector.id}-${run.start}`, AI_STEP, readAloud(videoId, detector, posts), { "app.posts": posts.length });
            found[i] = withAloud.map((m) => ({ ...m, detector: detector.id }));
          });
          mentions.push(...found.flat());
        }, attributes);
      }
    }

    const stored = await steps.phase("store", async (steps) => {
      const stored = await steps.do("store-db", IO_STEP, storeMentions(videoId, mentions));
      await steps.do("store-vectors", IO_STEP, storeVectors(videoId, stored));
      return stored.length;
    });
    await steps.do("cleanup", IO_STEP, cleanup(videoId));
    return {
      outcome: isShort ? "skipped" : "done",
      facts: {
        "video.duration": manifest.duration ?? 0,
        "video.frames": manifest.frames,
        "video.mentions": stored,
        "video.read_aloud": mentions.filter((m) => m.readAloudAt !== null).length,
        "transcript.words": words,
        "app.transcript_origin": origin,
      },
    };
  }

  private async extract(videoId: string, instanceId: string, steps: Steps): Promise<Manifest | "not_ready" | "skipped"> {
    const token = this.env.INTERNAL_TOKEN;
    await steps.do("extract-start", START_STEP, startJob(videoId, instanceId, token));
    // Only a timeout or a restart uses up a wait. A stop event from a container that is gone, with the job
    // still running, does not.
    for (let wait = 0, used = 0; used < MAX_EXTRACT_WAITS; wait++) {
      // Step names must differ, but only a job that outlives its first wait needs a number.
      const retry = wait ? `-${wait}` : "";
      const event = await steps.waitForEvent<JobStatus>(`extract-done${retry}`, { type: EXTRACT_EVENT, timeout: EXTRACT_WAIT })
        .then((event) => event.payload, () => null);
      let job = event;
      if (!job || job.state === "stopped") {
        job = await steps.do(`extract-check${retry}`, START_STEP, checkJob(videoId, instanceId, token));
        if (!event || job.restarted) used++;
      }
      if (job.state === "running") continue;
      await steps.do("extract-release", IO_STEP, destroyContainer(videoId));
      if (job.state === "error") {
        if (job.error === "not_ready") return "not_ready";
        if (job.error === "members_only") return "skipped";
        throw new NonRetryableError(`extract failed at ${job.stage}: ${job.error}`);
      }
      const { manifest } = job;
      if (!manifest) throw new NonRetryableError("extract finished without a manifest");
      await steps.do("save-metadata", IO_STEP, Effect.gen(function* () {
        yield* sql.run(
          `UPDATE videos SET title = COALESCE(title, ?), duration = COALESCE(?, duration),
           published_at = COALESCE(published_at, ?) WHERE id = ?`,
          manifest.title, manifest.duration, isoOrNull(manifest.publishedAt), videoId,
        );
        yield* Effect.logInfo(`Extracted ${manifest.frames} frames from ${manifest.duration ?? "?"} s of video, captions: ${manifest.hasCaptions}`).pipe(
          Effect.annotateLogs({ "video.id": videoId, "extract.waits": wait + 1 }),
        );
        if (manifest.captionsError) {
          yield* Effect.logWarning(`No captions for ${videoId}, using whisper: ${manifest.captionsError}`).pipe(Effect.annotateLogs({ "video.id": videoId }));
        }
        yield* annotate({ "video.duration": manifest.duration ?? undefined, "video.frames": manifest.frames, "extract.waits": wait + 1 });
      }));
      return manifest;
    }
    throw new NonRetryableError(`extract did not finish after ${MAX_EXTRACT_WAITS} timeouts or restarts`);
  }

  private async transcribeAudio(videoId: string, chunks: number, steps: Steps): Promise<void> {
    for (let i = 0; i < chunks; i++) {
      await steps.do(`transcribe-${i}`, AI_STEP, Effect.gen(function* () {
        const audioKey = key(videoId, `audio/${String(i).padStart(3, "0")}.mp3`);
        const audio = yield* r2("GetObject", audioKey, (bucket) => bucket.get(audioKey));
        if (!audio) return yield* Effect.fail(new Error(`missing audio chunk ${i}`));
        const words = yield* transcribe(yield* Effect.promise(() => audio.arrayBuffer()), i * AUDIO_CHUNK_SECONDS);
        const wordsKey = key(videoId, `words-${i}.json`);
        yield* r2("PutObject", wordsKey, (bucket) => bucket.put(wordsKey, JSON.stringify(words)));
        return words.length;
      }));
    }
    await steps.do("merge-words", IO_STEP, Effect.gen(function* () {
      const all: Word[] = [];
      for (let i = 0; i < chunks; i++) {
        const partKey = key(videoId, `words-${i}.json`);
        const part = yield* r2("GetObject", partKey, (bucket) => bucket.get(partKey));
        if (part) all.push(...(yield* Effect.promise(() => part.json<Word[]>())));
      }
      all.sort((a, b) => a[0] - b[0]);
      const wordsKey = key(videoId, "words.json");
      yield* r2("PutObject", wordsKey, (bucket) => bucket.put(wordsKey, JSON.stringify(all.map(([t, w]) => [Math.round(t * 100) / 100, w]))));
    }));
  }

  private async detect(videoId: string, detector: Detector, manifest: Manifest, timeline: number[], steps: Steps): Promise<number[]> {
    const kept = frameSeconds(manifest.frames, manifest.keptSeconds);
    const batches = Array.from({ length: Math.ceil(kept.length / DETECT_BATCH) }, (_, b) => kept.slice(b * DETECT_BATCH, (b + 1) * DETECT_BATCH));
    const probs: number[][] = new Array(batches.length);
    await pool(batches, DETECT_STEPS, async (seconds, b) => {
      probs[b] = await steps.do(`detect-${detector.id}-${b * DETECT_BATCH}`, AI_STEP, Effect.forEach(seconds, (second) =>
        Effect.gen(function* () {
          const frameKey = key(videoId, `f640/${second}.jpg`);
          const frame = yield* r2("GetObject", frameKey, (bucket) => bucket.get(frameKey));
          if (!frame) return yield* Effect.fail(new Error(`missing detection frame ${second}`));
          const p = yield* detectFrame(detector, yield* Effect.promise(() => frame.arrayBuffer()), { videoId, second, size: "f640" });
          return Math.round(p * 1000) / 1000;
        }), { concurrency: DETECT_CONCURRENCY }), { "app.frames": seconds.length });
    });
    return inheritProbabilities(timeline, kept, probs.flat());
  }
}

/** Runs `fn` on every item, at most `size` at a time. Each call is a durable step, so this stays plain async. */
async function pool<T>(items: T[], size: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  }));
}

const startJob = (videoId: string, instanceId: string, token: string) =>
  Effect.gen(function* () {
    // Before the POST, so a container that stops as soon as the job starts still reports it.
    yield* watchContainerJob(videoId, instanceId);
    const res = yield* containerFetch(videoId, "/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId, instanceId, uploadBase: `http://${UPLOAD_HOST}`, token }),
    });
    if (!res.ok) return yield* Effect.fail(new Error(`container POST /jobs: ${res.status} ${(yield* Effect.promise(() => res.text())).slice(0, 200)}`));
    const { protocol } = yield* Effect.promise(() => res.json<{ protocol?: number }>());
    if (protocol !== JOB_PROTOCOL) {
      yield* destroyContainer(videoId);
      return yield* Effect.fail(new Error(`container speaks job protocol ${protocol ?? 1}, not ${JOB_PROTOCOL}: its image is from before a rollout`));
    }
  });

/**
 * The job status when its event did not come or its container stopped. A container that lost its job may have
 * finished it first: then the manifest is in R2, because the job writes it last. Otherwise the job starts again.
 */
const checkJob = (videoId: string, instanceId: string, token: string): Effect.Effect<JobStatus, unknown, App> =>
  Effect.gen(function* () {
    const res = yield* containerFetch(videoId, `/jobs/${videoId}`);
    if (res.status === 404) {
      const manifestKey = key(videoId, "manifest.json");
      const object = yield* r2("GetObject", manifestKey, (bucket) => bucket.get(manifestKey));
      const manifest = object ? yield* Effect.promise(() => object.json<Manifest>()) : null;
      if (manifest) return { state: "done", stage: "done", error: null, manifest } as JobStatus;
      yield* startJob(videoId, instanceId, token);
      return { state: "running", stage: null, error: null, manifest: null, restarted: true } as JobStatus;
    }
    if (!res.ok) return yield* Effect.fail(new Error(`container GET /jobs: ${res.status}`));
    const job = (yield* Effect.promise(() => res.json())) as JobStatus;
    yield* annotate({ "container.state": job.state, "container.stage": job.stage ?? "", "container.uploaded": job.uploaded ?? 0, "container.upload_total": job.total ?? 0 });
    return job;
  });

const readRun = (videoId: string, detector: Detector, run: Run, timeline: number[]) =>
  Effect.gen(function* () {
    const observations: Observation[] = [];
    yield* Effect.forEach(pickSeconds(run), (second) =>
      Effect.gen(function* () {
        const frameKey = key(videoId, `f1920/${timeline[second]}.jpg`);
        const frame = yield* r2("GetObject", frameKey, (bucket) => bucket.get(frameKey));
        if (!frame) return yield* Effect.fail(new Error(`missing reader frame ${timeline[second]}`));
        const lines = yield* readPosts(detector, yield* Effect.promise(() => frame.arrayBuffer()), { videoId, second: timeline[second], size: "f1920" });
        for (const line of lines) observations.push({ second, line });
      }), { concurrency: READ_CONCURRENCY, discard: true });
    const canonical = canonicalHandles(countHandles(yield* catalogHandles(videoId)));
    const posts = groupPosts(observations).map((post) => withCanonicalHandle({ ...post, frameSecond: timeline[post.frameSecond] }, canonical));
    yield* annotate({ "app.posts": posts.length });
    return posts;
  });

/** Leaves out `videoId`, so a rerun or a retried store does not count that video's own rows twice. */
const catalogHandles = (videoId: string) =>
  sql.all<{ handle: string; displayName: string }>("SELECT handle, display_name AS displayName FROM mentions WHERE handle_norm != '' AND video_id != ?", videoId);

const loadWords = (videoId: string) =>
  Effect.gen(function* () {
    const wordsKey = key(videoId, "words.json");
    const object = yield* r2("GetObject", wordsKey, (bucket) => bucket.get(wordsKey));
    return object ? yield* Effect.promise(() => object.json<Word[]>()) : [];
  });

/** Cleanup deletes the video's prefix, so the transcript is kept outside it for bots to read later. */
const keepTranscript = (videoId: string, origin: "captions" | "whisper") =>
  Effect.gen(function* () {
    const words = yield* loadWords(videoId);
    if (words.length) {
      const transcript = transcriptKey(videoId);
      yield* r2("PutObject", transcript, (bucket) => bucket.put(transcript, JSON.stringify({ videoId, origin, words }), { httpMetadata: { contentType: "application/json" } }));
    }
    yield* Effect.logInfo(`Kept ${words.length} transcript words from ${origin}`).pipe(Effect.annotateLogs({ "video.id": videoId }));
    yield* annotate({ "transcript.words": words.length, "app.transcript_origin": origin });
    return words.length;
  });

const readAloud = (videoId: string, detector: Detector, posts: PostGroup[]) =>
  Effect.gen(function* () {
    const words = yield* loadWords(videoId);
    const mentions: Mention[] = posts.map((p) => ({ ...p, detector: detector.id, readAloudP: null, readAloudAt: null, quote: null }));
    if (words.length === 0) {
      yield* annotate({ "read_aloud.no_transcript": mentions.length });
      return mentions;
    }
    const results = new Map<Mention, ReadAloudResult>();
    yield* Effect.forEach(mentions, (mention) =>
      Effect.gen(function* () {
        const { result, text, search } = yield* checkReadAloud(detector, mention, words);
        results.set(mention, result);
        yield* annotate({
          "app.post.text": text,
          "read_aloud.result": result,
          "read_aloud.how": search?.how ?? undefined,
          "read_aloud.question": search?.question,
          "read_aloud.clairic_answer": search?.answer ?? undefined,
          "read_aloud.p": mention.readAloudP ?? undefined,
          "read_aloud.at": mention.readAloudAt ?? undefined,
          "read_aloud.quote": mention.quote ?? undefined,
          "read_aloud.youtube_url": mention.readAloudAt === null ? undefined : `https://www.youtube.com/watch?v=${videoId}&t=${mention.readAloudAt}s`,
        });
      }).pipe(span(`read aloud ${mention.handle}`, "function", {
        "app.post.handle": mention.handle,
        "app.post.first_seen": mention.firstSeen,
        "app.post.last_seen": mention.lastSeen,
        ...frameAttributes({ videoId, second: mention.frameSecond, size: "f1920" }),
      })), { concurrency: READ_ALOUD_CONCURRENCY, discard: true });
    for (const [mention, result] of results) {
      if (result === "read") {
        yield* Effect.logInfo(`${mention.handle} was read aloud at ${mention.readAloudAt} s`).pipe(
          Effect.annotateLogs({ "video.id": videoId, "read_aloud.p": mention.readAloudP!, "read_aloud.quote": mention.quote! }),
        );
      }
    }
    return mentions;
  });

const checkReadAloud = (detector: Detector, mention: Mention, words: Word[]): Effect.Effect<{ result: ReadAloudResult; text: string; search?: QuoteSearch }, unknown, App> =>
  Effect.gen(function* () {
    // A run can hold many posts, and the talk about the post before or after this one is not a reading of it.
    const window = buildWindow(words, mention.firstSeen - WINDOW_PADDING_SECONDS, mention.lastSeen + WINDOW_PADDING_SECONDS);
    if (!window.text) return { result: "no_transcript", text: mention.slices[0] } as const;
    let post = { handle: mention.handle, displayName: mention.displayName, text: mention.slices[0] };
    let p = 0;
    for (const text of mention.slices.slice(0, READ_ALOUD_SLICES)) {
      const candidate = { ...post, text };
      const q = yield* readAloudProbability(detector, candidate, window.text);
      if (q > p) [p, post] = [q, candidate];
    }
    mention.readAloudP = Math.round(p * 1000) / 1000;
    if (p < detector.readAloudThreshold) return { result: "not_read", text: post.text } as const;
    const search = yield* findQuote(detector, post, window.text);
    if (!search.span) return { result: "no_quote", text: post.text, search } as const;
    mention.readAloudAt = Math.floor(timeAtOffset(window.offsets, search.span[0]) ?? mention.firstSeen);
    mention.quote = expandSentence(window.text, search.span[0], search.span[1]);
    return { result: "read", text: post.text, search } as const;
  });

/**
 * Replaces all mentions of the video in one batch, so a retried step starts clean. The batch also queues
 * the old vectors in `stale_vectors`, which `storeVectors` drains, so a retry cannot lose them.
 */
const storeMentions = (videoId: string, found: Mention[]) =>
  Effect.gen(function* () {
    // Runs are read apart, so only here can all of a video's spellings of a new handle count together.
    const canonical = canonicalHandles(countHandles([...(yield* catalogHandles(videoId)), ...found]));
    const mentions = found.map((m) => withCanonicalHandle(m, canonical));
    const insert = `INSERT INTO mentions (video_id, detector, handle, handle_norm, display_name, text, first_seen, last_seen,
               frame_second, read_aloud_p, read_aloud_at, quote) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const statements: [string, ...unknown[]][] = [
      ["INSERT OR IGNORE INTO stale_vectors (vector_id, video_id) SELECT video_id || ':' || id, video_id FROM mentions WHERE video_id = ?", videoId],
      ["INSERT INTO mentions_fts(mentions_fts, rowid, text) SELECT 'delete', id, text FROM mentions WHERE video_id = ?", videoId],
      ["DELETE FROM mentions WHERE video_id = ?", videoId],
      ...mentions.map((m): [string, ...unknown[]] => [insert, videoId, m.detector, m.handle, normalizeHandle(m.handle), m.displayName, m.text, m.firstSeen, m.lastSeen, m.frameSecond, m.readAloudP, m.readAloudAt, m.quote]),
      ["INSERT INTO mentions_fts(rowid, text) SELECT id, text FROM mentions WHERE video_id = ?", videoId],
    ];
    const queries = [...new Set(statements.map(([query]) => query))];
    yield* d1(queries.join("\n;\n"), (db) => db.batch(statements.map(([query, ...binds]) => db.prepare(query).bind(...binds))));
    const stored = yield* sql.all<{ id: number; handle: string; text: string }>("SELECT id, handle, text FROM mentions WHERE video_id = ? ORDER BY id", videoId);
    yield* Effect.logInfo(`Stored ${stored.length} mentions`).pipe(Effect.annotateLogs({ "video.id": videoId }));
    yield* annotate({ "video.mentions": stored.length });
    return stored;
  });

const storeVectors = (videoId: string, mentions: { id: number; handle: string; text: string }[]) =>
  Effect.gen(function* () {
    const stale = yield* sql.all<{ vector_id: string }>("SELECT vector_id FROM stale_vectors WHERE video_id = ?", videoId);
    for (let i = 0; i < stale.length; i += 100) {
      const ids = stale.slice(i, i + 100).map((r) => r.vector_id);
      yield* vectorize("deleteByIds", ids.length, (index) => index.deleteByIds(ids));
    }
    yield* sql.run("DELETE FROM stale_vectors WHERE video_id = ?", videoId);
    for (let i = 0; i < mentions.length; i += EMBED_BATCH) {
      const batch = mentions.slice(i, i + EMBED_BATCH);
      const vectors = yield* embed(batch.map((m) => (m.handle === UNKNOWN_HANDLE ? m.text : `${m.handle}: ${m.text}`)));
      const records = batch.map((m, j) => ({ id: `${videoId}:${m.id}`, values: vectors[j], metadata: { videoId, mentionId: m.id, handle: m.handle } }));
      yield* vectorize("upsert", records.length, (index) => index.upsert(records));
    }
  });

/** Keeps frame images for the retention sweep. */
const cleanup = (videoId: string) =>
  Effect.gen(function* () {
    let deleted = 0;
    let cursor: string | undefined;
    const prefix = key(videoId, "");
    do {
      const page = yield* r2("ListObjects", prefix, (bucket) => bucket.list({ prefix, cursor, limit: 1000 }));
      const keys = page.objects.map((o) => o.key).filter((k) => !/^videos\/[^/]+\/f(?:640|1280|1920)\//.test(k));
      if (keys.length) yield* r2("DeleteObject", prefix, (bucket) => bucket.delete(keys));
      deleted += keys.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    yield* annotate({ "cleanup.deleted": deleted });
    return deleted;
  });

export { VideoPipeline as VideoWorkflow };

function audioChunkCount(manifest: Manifest): number {
  return Array.isArray(manifest.audioChunks) ? manifest.audioChunks.length : manifest.audioChunks;
}
