import { captureException, captureMessage, getActiveSpan, instrumentWorkflowWithSentry, logger, metrics } from "@sentry/cloudflare";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { detectFrame, embed, findQuoteSpan, pool, readAloudProbability, readFrame, transcribe } from "./ai";
import { MIN_DURATION_SECONDS, getDetector, getSource, type Detector } from "./config";
import type { Env, VideoParams } from "./env";
import {
  buildWindow,
  frameSeconds,
  frameTimeline,
  inheritProbabilities,
  expandSentence,
  findRuns,
  groupPosts,
  parseReaderLines,
  pickSeconds,
  timeAtOffset,
  type Observation,
  type PostGroup,
  type Run,
  type Word,
} from "./pipeline";
import { EXTRACT_EVENT, JOB_PROTOCOL, UPLOAD_HOST } from "./container";
import { phase, sentryOptions, step as traceStep, waitForEvent, type PhaseStep } from "./telemetry";
import { containerFetch, destroyContainer, endRun, isoOrNull, setStatus, startRun, watchContainerJob } from "./videos";

const DETECT_BATCH = 120;
const DETECT_CONCURRENCY = 10;
/**
 * Workers AI returned error 3021 for clef-flash with 3 steps of 12 calls, and after about a minute with 2 steps of 12.
 * 2 steps of 10 calls ran for 93 s with no 3021, at about 1,600 calls a minute.
 */
const DETECT_STEPS = 2;
const READ_CONCURRENCY = 6;
/** Most runs need 1 to 5 gemma calls, so 3 runs at a time keep gemma under its 300 calls a minute. */
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

const key = (videoId: string, path: string) => `videos/${videoId}/${path}`;
const transcriptKey = (videoId: string) => `transcripts/${videoId}.json`;

class Workflow extends WorkflowEntrypoint<Env, VideoParams> {
  async run(event: WorkflowEvent<VideoParams>, step: WorkflowStep): Promise<void> {
    const { videoId, source } = event.payload;
    const env = this.env;
    const { instanceId } = event;
    try {
      await step.do("mark-processing", IO_STEP, async () => {
        await startRun(env, videoId, instanceId);
        await setStatus(env, videoId, "processing");
      });
      const outcome = await this.process(videoId, source, instanceId, step);
      const pending = outcome === "not_ready";
      await step.do("mark-final", IO_STEP, async () => {
        // endRun writes once, so it goes last: a failed status write must leave the run open for mark-error.
        await setStatus(env, videoId, pending ? "pending" : outcome, pending ? "not ready yet, will retry" : null);
        await endRun(env, instanceId, outcome);
        if (pending) captureMessage(`${videoId} not ready: ${outcome}`, { level: "warning", tags: { "video.id": videoId, "video.not_ready": outcome } });
        logger.info(logger.fmt`Video ${videoId} finished: ${outcome}`, { "video.id": videoId, "video.source": source });
        metrics.count("video.processed", 1, { attributes: { "video.outcome": outcome, "video.source": source } });
      });
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      await step.do("mark-error", IO_STEP, async () => {
        await endRun(env, instanceId, "error", message);
        await setStatus(env, videoId, "error", message);
        // The Sentry step wrapper reports an error only after the step's last retry, so it never sees these.
        if (err instanceof NonRetryableError) captureException(err, { tags: { "video.id": videoId } });
        logger.error(logger.fmt`Video ${videoId} failed: ${message}`, { "video.id": videoId, "video.source": source });
        metrics.count("video.processed", 1, { attributes: { "video.outcome": "error", "video.source": source } });
      });
      throw err;
    }
  }

  private async process(videoId: string, sourceId: string, instanceId: string, step: WorkflowStep): Promise<"done" | "skipped" | "not_ready"> {
    const env = this.env;
    const config = getSource(sourceId);
    if (!config) throw new NonRetryableError(`unknown source ${sourceId}`);
    const detectors = config.detectors.map(getDetector);

    const manifest = await phase("extract", step, (step) => this.extract(videoId, instanceId, step));
    if (typeof manifest === "string") return manifest;

    const isShort = manifest.duration != null && manifest.duration < MIN_DURATION_SECONDS;
    const mentions: Mention[] = [];
    const timeline = frameTimeline(manifest.frames, manifest.keptSeconds);

    const origin = manifest.hasCaptions ? "captions" : "whisper";
    await phase("transcribe", step, async (step) => {
      if (!isShort && !manifest.hasCaptions) await this.transcribeAudio(videoId, audioChunkCount(manifest), step);
      await step.do("keep-transcript", IO_STEP, () => this.keepTranscript(videoId, origin));
    }, { "app.transcript_origin": origin });

    if (!isShort) {
      for (const detector of detectors) {
        const attributes = { "app.detector": detector.id };
        const probs = await phase("detect", step, (step) => this.detect(videoId, detector, manifest, timeline, step), attributes);
        await phase("read", step, async (step) => {
          const runs = findRuns(probs, detector.frameThreshold);
          const found: Mention[][] = runs.map(() => []);
          await pool(runs, READ_RUNS, async (run, i) => {
            const posts = await step.do(`read-${detector.id}-${run.start}`, AI_STEP, () =>
              this.readRun(videoId, detector, run, timeline),
            );
            if (posts.length === 0) return;
            const withAloud = await step.do(`read-aloud-${detector.id}-${run.start}`, AI_STEP, () =>
              this.readAloud(videoId, detector, posts),
            );
            found[i] = withAloud.map((m) => ({ ...m, detector: detector.id }));
          });
          mentions.push(...found.flat());
        }, attributes);
      }
    }

    await phase("store", step, async (step) => {
      const stored = await step.do("store-db", IO_STEP, () => this.storeMentions(videoId, mentions));
      await step.do("store-vectors", IO_STEP, () => this.storeVectors(videoId, stored));
    });
    await step.do("cleanup", IO_STEP, () => this.cleanup(videoId));
    return isShort ? "skipped" : "done";
  }

  private async startJob(videoId: string, instanceId: string): Promise<void> {
    // Before the POST, so a container that stops as soon as the job starts still reports it.
    await watchContainerJob(this.env, videoId, instanceId);
    const res = await containerFetch(this.env, videoId, "/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId, instanceId, uploadBase: `http://${UPLOAD_HOST}`, token: this.env.INTERNAL_TOKEN }),
    });
    if (!res.ok) throw new Error(`container POST /jobs: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { protocol } = await res.json<{ protocol?: number }>();
    if (protocol !== JOB_PROTOCOL) {
      await destroyContainer(this.env, videoId);
      throw new Error(`container speaks job protocol ${protocol ?? 1}, not ${JOB_PROTOCOL}: its image is from before a rollout`);
    }
  }

  /**
   * The job status when its event did not come or its container stopped. A container that lost its job may have
   * finished it first: then the manifest is in R2, because the job writes it last. Otherwise the job starts again.
   */
  private async checkJob(videoId: string, instanceId: string): Promise<JobStatus> {
    const res = await containerFetch(this.env, videoId, `/jobs/${videoId}`);
    if (res.status === 404) {
      const manifest = await (await this.env.BUCKET.get(key(videoId, "manifest.json")))?.json<Manifest>();
      if (manifest) return { state: "done", stage: "done", error: null, manifest };
      await this.startJob(videoId, instanceId);
      return { state: "running", stage: null, error: null, manifest: null, restarted: true };
    }
    if (!res.ok) throw new Error(`container GET /jobs: ${res.status}`);
    const job = (await res.json()) as JobStatus;
    getActiveSpan()?.setAttributes({
      "container.state": job.state,
      "container.stage": job.stage ?? "",
      "container.uploaded": job.uploaded ?? 0,
      "container.upload_total": job.total ?? 0,
    });
    return job;
  }

  private async extract(videoId: string, instanceId: string, step: PhaseStep): Promise<Manifest | "not_ready"> {
    await step.do("extract-start", START_STEP, () => this.startJob(videoId, instanceId));
    // Only a timeout or a restart uses up a wait. A stop event from a container that is gone, with the job
    // still running, does not.
    for (let wait = 0, used = 0; used < MAX_EXTRACT_WAITS; wait++) {
      // Step names must differ, but only a job that outlives its first wait needs a number.
      const retry = wait ? `-${wait}` : "";
      const event = await waitForEvent<JobStatus>(step, `extract-done${retry}`, { type: EXTRACT_EVENT, timeout: EXTRACT_WAIT })
        .then((event) => event.payload, () => null);
      let job = event;
      if (!job || job.state === "stopped") {
        job = await step.do(`extract-check${retry}`, START_STEP, () => this.checkJob(videoId, instanceId));
        if (!event || job.restarted) used++;
      }
      if (job.state === "running") continue;
      await step.do("extract-release", IO_STEP, () => destroyContainer(this.env, videoId));
      if (job.state === "error") {
        if (job.error === "not_ready") return "not_ready";
        throw new NonRetryableError(`extract failed at ${job.stage}: ${job.error}`);
      }
      const { manifest } = job;
      if (!manifest) throw new NonRetryableError("extract finished without a manifest");
      await step.do("save-metadata", IO_STEP, async () => {
        await this.env.DB.prepare(
          `UPDATE videos SET title = COALESCE(title, ?), duration = COALESCE(?, duration),
           published_at = COALESCE(published_at, ?) WHERE id = ?`,
        )
          .bind(manifest.title, manifest.duration, isoOrNull(manifest.publishedAt), videoId)
          .run();
        logger.info(logger.fmt`Extracted ${manifest.frames} frames from ${manifest.duration ?? "?"} s of video, captions: ${manifest.hasCaptions}`, {
          "video.id": videoId,
          "extract.waits": wait + 1,
        });
        if (manifest.captionsError) {
          logger.warn(logger.fmt`No captions for ${videoId}, using whisper: ${manifest.captionsError}`, { "video.id": videoId });
        }
        if (manifest.duration != null) metrics.distribution("video.duration", manifest.duration, { unit: "second" });
      });
      return manifest;
    }
    throw new NonRetryableError(`extract did not finish after ${MAX_EXTRACT_WAITS} timeouts or restarts`);
  }

  private async transcribeAudio(videoId: string, chunks: number, step: PhaseStep): Promise<void> {
    const env = this.env;
    for (let i = 0; i < chunks; i++) {
      await step.do(`transcribe-${i}`, AI_STEP, async () => {
        const audio = await env.BUCKET.get(key(videoId, `audio/${String(i).padStart(3, "0")}.mp3`));
        if (!audio) throw new Error(`missing audio chunk ${i}`);
        const words = await transcribe(env, await audio.arrayBuffer(), i * AUDIO_CHUNK_SECONDS);
        await env.BUCKET.put(key(videoId, `words-${i}.json`), JSON.stringify(words));
        return words.length;
      });
    }
    await step.do("merge-words", IO_STEP, async () => {
      const all: Word[] = [];
      for (let i = 0; i < chunks; i++) {
        const part = await env.BUCKET.get(key(videoId, `words-${i}.json`));
        if (part) all.push(...(await part.json<Word[]>()));
      }
      all.sort((a, b) => a[0] - b[0]);
      await env.BUCKET.put(key(videoId, "words.json"), JSON.stringify(all.map(([t, w]) => [Math.round(t * 100) / 100, w])));
    });
  }

  private async detect(videoId: string, detector: Detector, manifest: Manifest, timeline: number[], step: PhaseStep): Promise<number[]> {
    const env = this.env;
    const kept = frameSeconds(manifest.frames, manifest.keptSeconds);
    const batches = Array.from({ length: Math.ceil(kept.length / DETECT_BATCH) }, (_, b) =>
      kept.slice(b * DETECT_BATCH, (b + 1) * DETECT_BATCH),
    );
    const probs: number[][] = new Array(batches.length);
    await pool(batches, DETECT_STEPS, async (seconds, b) => {
      probs[b] = await step.do(`detect-${detector.id}-${b * DETECT_BATCH}`, AI_STEP, async () => {
        const out: number[] = new Array(seconds.length).fill(0);
        await pool(seconds, DETECT_CONCURRENCY, async (second, i) => {
          const frame = await env.BUCKET.get(key(videoId, `f640/${second}.jpg`));
          if (!frame) throw new Error(`missing detection frame ${second}`);
          out[i] = Math.round((await detectFrame(env, detector, await frame.arrayBuffer(), { videoId, second, size: "f640" })) * 1000) / 1000;
        });
        return out;
      });
    });
    return inheritProbabilities(timeline, kept, probs.flat());
  }

  private async readRun(videoId: string, detector: Detector, run: Run, timeline: number[]): Promise<PostGroup[]> {
    const env = this.env;
    const observations: Observation[] = [];
    await pool(pickSeconds(run), READ_CONCURRENCY, async (second) => {
      const frame = await env.BUCKET.get(key(videoId, `f1280/${timeline[second]}.jpg`));
      if (!frame) throw new Error(`missing reader frame ${timeline[second]}`);
      const output = await readFrame(env, detector, await frame.arrayBuffer(), { videoId, second: timeline[second], size: "f1280" });
      for (const line of parseReaderLines(output)) observations.push({ second, line });
    });
    return groupPosts(observations).map((post) => ({ ...post, frameSecond: timeline[post.frameSecond] }));
  }

  private async loadWords(videoId: string): Promise<Word[]> {
    const object = await this.env.BUCKET.get(key(videoId, "words.json"));
    return object ? await object.json<Word[]>() : [];
  }

  /** Cleanup deletes the video's prefix, so the transcript is kept outside it for bots to read later. */
  private async keepTranscript(videoId: string, origin: "captions" | "whisper"): Promise<number> {
    const words = await this.loadWords(videoId);
    if (words.length) {
      await this.env.BUCKET.put(transcriptKey(videoId), JSON.stringify({ videoId, origin, words }), {
        httpMetadata: { contentType: "application/json" },
      });
    }
    logger.info(logger.fmt`Kept ${words.length} transcript words from ${origin}`, { "video.id": videoId });
    metrics.distribution("transcript.words", words.length, { attributes: { "app.transcript_origin": origin } });
    return words.length;
  }

  private async readAloud(videoId: string, detector: Detector, posts: PostGroup[]): Promise<Mention[]> {
    const env = this.env;
    const words = await this.loadWords(videoId);
    const mentions: Mention[] = posts.map((p) => ({ ...p, detector: detector.id, readAloudP: null, readAloudAt: null, quote: null }));
    if (words.length === 0) {
      metrics.count("read_aloud.checks", mentions.length, { attributes: { "app.detector": detector.id, "read_aloud.result": "no_transcript" } });
      return mentions;
    }

    const results = new Map<Mention, "read" | "not_read" | "no_quote" | "no_transcript">();
    await pool(mentions, READ_ALOUD_CONCURRENCY, async (mention) => {
      // A run can hold many posts, and the talk about the post before or after this one is not a reading of it.
      const window = buildWindow(words, mention.firstSeen - WINDOW_PADDING_SECONDS, mention.lastSeen + WINDOW_PADDING_SECONDS);
      if (!window.text) return void results.set(mention, "no_transcript");
      let post = { handle: mention.handle, displayName: mention.displayName, text: mention.slices[0] };
      let p = 0;
      for (const text of mention.slices.slice(0, READ_ALOUD_SLICES)) {
        const candidate = { ...post, text };
        const q = await readAloudProbability(env, detector, candidate, window.text);
        if (q > p) [p, post] = [q, candidate];
      }
      mention.readAloudP = Math.round(p * 1000) / 1000;
      results.set(mention, "not_read");
      if (p < detector.readAloudThreshold) return;
      const span = await findQuoteSpan(env, detector, post, window.text);
      results.set(mention, span ? "read" : "no_quote");
      if (!span) return;
      mention.readAloudAt = Math.floor(timeAtOffset(window.offsets, span[0]) ?? mention.firstSeen);
      mention.quote = expandSentence(window.text, span[0], span[1]);
    });
    // After the pool, so a failed check that retries the step cannot count the others twice.
    for (const [mention, result] of results) {
      metrics.count("read_aloud.checks", 1, { attributes: { "app.detector": detector.id, "read_aloud.result": result } });
      if (result === "read") {
        logger.info(logger.fmt`${mention.handle} was read aloud at ${mention.readAloudAt} s`, {
          "video.id": videoId,
          "read_aloud.p": mention.readAloudP!,
          "read_aloud.quote": mention.quote!,
        });
      }
    }
    return mentions;
  }

  /**
   * Replaces all mentions of the video in one batch, so a retried step starts clean. The batch also queues
   * the old vectors in `stale_vectors`, which `storeVectors` drains, so a retry cannot lose them.
   */
  private async storeMentions(videoId: string, mentions: Mention[]) {
    const db = this.env.DB;
    await db.batch([
      db
        .prepare("INSERT OR IGNORE INTO stale_vectors (vector_id, video_id) SELECT video_id || ':' || id, video_id FROM mentions WHERE video_id = ?")
        .bind(videoId),
      db.prepare("INSERT INTO mentions_fts(mentions_fts, rowid, text) SELECT 'delete', id, text FROM mentions WHERE video_id = ?").bind(videoId),
      db.prepare("DELETE FROM mentions WHERE video_id = ?").bind(videoId),
      ...mentions.map((m) =>
        db
          .prepare(
            `INSERT INTO mentions (video_id, detector, handle, handle_norm, display_name, text, first_seen, last_seen,
               frame_second, read_aloud_p, read_aloud_at, quote) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            videoId, m.detector, m.handle, m.handle.replace(/^@/, "").toLowerCase(), m.displayName, m.text,
            m.firstSeen, m.lastSeen, m.frameSecond, m.readAloudP, m.readAloudAt, m.quote,
          ),
      ),
      db.prepare("INSERT INTO mentions_fts(rowid, text) SELECT id, text FROM mentions WHERE video_id = ?").bind(videoId),
    ]);
    const { results: stored } = await db
      .prepare("SELECT id, handle, text FROM mentions WHERE video_id = ? ORDER BY id")
      .bind(videoId)
      .all<{ id: number; handle: string; text: string }>();
    logger.info(logger.fmt`Stored ${stored.length} mentions`, { "video.id": videoId });
    metrics.distribution("video.mentions", stored.length);
    return stored;
  }

  private async storeVectors(videoId: string, mentions: { id: number; handle: string; text: string }[]): Promise<void> {
    const db = this.env.DB;
    const index = this.env.POSTS;
    const { results: stale } = await db
      .prepare("SELECT vector_id FROM stale_vectors WHERE video_id = ?")
      .bind(videoId)
      .all<{ vector_id: string }>();
    for (let i = 0; i < stale.length; i += 100) {
      const ids = stale.slice(i, i + 100).map((r) => r.vector_id);
      await traceStep("vectorize.deleteByIds", () => index.deleteByIds(ids), { count: ids.length });
    }
    await db.prepare("DELETE FROM stale_vectors WHERE video_id = ?").bind(videoId).run();
    for (let i = 0; i < mentions.length; i += EMBED_BATCH) {
      const batch = mentions.slice(i, i + EMBED_BATCH);
      const vectors = await embed(this.env, batch.map((m) => `${m.handle}: ${m.text}`));
      const records = batch.map((m, j) => ({
        id: `${videoId}:${m.id}`,
        values: vectors[j],
        metadata: { videoId, mentionId: m.id, handle: m.handle },
      }));
      await traceStep("vectorize.upsert", () => index.upsert(records), { count: records.length });
    }
  }

  /** Keeps frame images for the retention sweep. */
  private async cleanup(videoId: string): Promise<number> {
    const bucket = this.env.BUCKET;
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: key(videoId, ""), cursor, limit: 1000 });
      const keys = page.objects.map((o) => o.key).filter((k) => !/^videos\/[^/]+\/f(?:640|1280)\//.test(k));
      if (keys.length) await bucket.delete(keys);
      deleted += keys.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return deleted;
  }
}

/** Each `step.do` becomes a span; the model calls inside a step are its children. */
export const VideoWorkflow = instrumentWorkflowWithSentry(sentryOptions, Workflow);

function audioChunkCount(manifest: Manifest): number {
  return Array.isArray(manifest.audioChunks) ? manifest.audioChunks.length : manifest.audioChunks;
}
