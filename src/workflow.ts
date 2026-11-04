import { getActiveSpan, instrumentWorkflowWithSentry } from "@sentry/cloudflare";
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
import { UPLOAD_HOST } from "./container";
import { sentryOptions, step as traceStep } from "./telemetry";
import { containerFetch, destroyContainer, isoOrNull, setStatus } from "./videos";

const DETECT_BATCH = 120;
const DETECT_CONCURRENCY = 12;
const READ_CONCURRENCY = 6;
const READ_ALOUD_CONCURRENCY = 4;
const READ_ALOUD_SLICES = 3;
const WINDOW_PADDING_SECONDS = 30;
const AUDIO_CHUNK_SECONDS = 600;
const POLL_INTERVAL = "30 seconds";
const MAX_POLLS = 180; // 90 minutes
const EMBED_BATCH = 50;

const IO_STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
/** Waits out "Maximum number of running container instances exceeded" while other videos finish. */
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
  audioChunks: number | string[];
};

type JobPoll = {
  state: "running" | "done" | "error";
  stage: string | null;
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

/** YouTube asks some downloads to sign in while others from the same app pass, so a later attempt can work. */
const BOT_CHECK = /confirm you.re not a bot/i;

const key = (videoId: string, path: string) => `videos/${videoId}/${path}`;

class Workflow extends WorkflowEntrypoint<Env, VideoParams> {
  async run(event: WorkflowEvent<VideoParams>, step: WorkflowStep): Promise<void> {
    const { videoId, source } = event.payload;
    if (!getSource(source)) throw new NonRetryableError(`unknown source ${source}`);

    try {
      await step.do("mark-processing", IO_STEP, () => setStatus(this.env, videoId, "processing"));
      const outcome = await this.process(videoId, source, step);
      const note = outcome === "pending" ? "not ready yet, will retry" : null;
      await step.do("mark-final", IO_STEP, () => setStatus(this.env, videoId, outcome, note));
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      await step.do("mark-error", IO_STEP, () => setStatus(this.env, videoId, "error", message));
      throw err;
    }
  }

  private async process(videoId: string, sourceId: string, step: WorkflowStep): Promise<"done" | "skipped" | "pending"> {
    const env = this.env;
    const detectors = getSource(sourceId)!.detectors.map(getDetector);

    const manifest = await this.extract(videoId, step);
    if (manifest === "not_ready") return "pending";

    await step.do("save-metadata", IO_STEP, async () => {
      await env.DB.prepare(
        `UPDATE videos SET title = COALESCE(title, ?), duration = COALESCE(?, duration),
         published_at = COALESCE(published_at, ?) WHERE id = ?`,
      )
        .bind(manifest.title, manifest.duration, isoOrNull(manifest.publishedAt), videoId)
        .run();
    });

    const isShort = manifest.duration != null && manifest.duration < MIN_DURATION_SECONDS;
    const mentions: Mention[] = [];
    const timeline = frameTimeline(manifest.frames, manifest.keptSeconds);

    if (!isShort) {
      if (!manifest.hasCaptions) await this.transcribeAudio(videoId, audioChunkCount(manifest), step);

      for (const detector of detectors) {
        const probs = await this.detect(videoId, detector, manifest, timeline, step);
        for (const run of findRuns(probs, detector.frameThreshold)) {
          const posts = await step.do(`read-${detector.id}-${run.start}`, AI_STEP, () =>
            this.readRun(videoId, detector, run, timeline),
          );
          if (posts.length === 0) continue;
          const withAloud = await step.do(`read-aloud-${detector.id}-${run.start}`, AI_STEP, () =>
            this.readAloud(videoId, detector, run, posts),
          );
          mentions.push(...withAloud.map((m) => ({ ...m, detector: detector.id })));
        }
      }
    }

    const stored = await step.do("store-db", IO_STEP, () => this.storeMentions(videoId, mentions));
    await step.do("store-vectors", IO_STEP, () => this.storeVectors(videoId, stored));
    await step.do("cleanup", IO_STEP, () => this.cleanup(videoId));
    return isShort ? "skipped" : "done";
  }

  private async startJob(videoId: string): Promise<void> {
    const res = await containerFetch(this.env, videoId, "/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId, uploadBase: `http://${UPLOAD_HOST}`, token: this.env.INTERNAL_TOKEN }),
    });
    if (!res.ok) throw new Error(`container POST /jobs: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  private async pollJob(videoId: string): Promise<JobPoll> {
    const res = await containerFetch(this.env, videoId, `/jobs/${videoId}`);
    if (res.status === 404) {
      await this.startJob(videoId);
      return { state: "running", stage: null, error: null, manifest: null };
    }
    if (!res.ok) throw new Error(`container GET /jobs: ${res.status}`);
    const job = (await res.json()) as Partial<JobPoll>;
    const state = job.state ?? "running";
    getActiveSpan()?.setAttributes({
      "container.state": state,
      "container.stage": job.stage ?? "",
      "container.uploaded": job.uploaded ?? 0,
      "container.upload_total": job.total ?? 0,
    });
    let manifest = job.manifest ?? null;
    if (state === "done" && !manifest) {
      manifest = await (await this.env.BUCKET.get(key(videoId, "manifest.json")))?.json<Manifest>() ?? null;
    }
    return { state, stage: job.stage ?? null, uploaded: job.uploaded, total: job.total, error: job.error ?? null, manifest };
  }

  private async extract(videoId: string, step: WorkflowStep): Promise<Manifest | "not_ready"> {
    await step.do("extract-start", START_STEP, () => this.startJob(videoId));
    for (let i = 0; i < MAX_POLLS; i++) {
      await step.sleep(`extract-wait-${i}`, POLL_INTERVAL);
      const job = await step.do(`extract-poll-${i}`, IO_STEP, () => this.pollJob(videoId));
      if (job.state === "running") continue;
      await step.do("extract-release", IO_STEP, () => destroyContainer(this.env, videoId));
      if (job.state === "error") {
        if (job.error === "not_ready" || BOT_CHECK.test(job.error ?? "")) return "not_ready";
        throw new NonRetryableError(`extract failed at ${job.stage}: ${job.error}`);
      }
      if (!job.manifest) throw new NonRetryableError("extract finished without a manifest");
      return job.manifest;
    }
    throw new NonRetryableError("extract did not finish within 90 minutes");
  }

  private async transcribeAudio(videoId: string, chunks: number, step: WorkflowStep): Promise<void> {
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

  private async detect(videoId: string, detector: Detector, manifest: Manifest, timeline: number[], step: WorkflowStep): Promise<number[]> {
    const env = this.env;
    const probs: number[] = [];
    const kept = frameSeconds(manifest.frames, manifest.keptSeconds);
    for (let from = 0; from < kept.length; from += DETECT_BATCH) {
      const seconds = kept.slice(from, from + DETECT_BATCH);
      const batch = await step.do(`detect-${detector.id}-${from}`, AI_STEP, async () => {
        const out: number[] = new Array(seconds.length).fill(0);
        await pool(seconds, DETECT_CONCURRENCY, async (second, i) => {
          const frame = await env.BUCKET.get(key(videoId, `f640/${second}.jpg`));
          if (!frame) throw new Error(`missing detection frame ${second}`);
          out[i] = Math.round((await detectFrame(env, detector, await frame.arrayBuffer(), { videoId, second, size: "f640" })) * 1000) / 1000;
        });
        return out;
      });
      probs.push(...batch);
    }
    return inheritProbabilities(timeline, kept, probs);
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

  private async readAloud(videoId: string, detector: Detector, run: Run, posts: PostGroup[]): Promise<Mention[]> {
    const env = this.env;
    const window = buildWindow(
      await this.loadWords(videoId),
      run.start - WINDOW_PADDING_SECONDS,
      run.end + WINDOW_PADDING_SECONDS,
    );
    const mentions: Mention[] = posts.map((p) => ({ ...p, detector: detector.id, readAloudP: null, readAloudAt: null, quote: null }));
    if (!window.text) return mentions;

    await pool(mentions, READ_ALOUD_CONCURRENCY, async (mention) => {
      let post = { handle: mention.handle, displayName: mention.displayName, text: mention.slices[0] };
      let p = 0;
      for (const text of mention.slices.slice(0, READ_ALOUD_SLICES)) {
        const candidate = { ...post, text };
        const q = await readAloudProbability(env, detector, candidate, window.text);
        if (q > p) [p, post] = [q, candidate];
      }
      mention.readAloudP = Math.round(p * 1000) / 1000;
      if (p < detector.readAloudThreshold) return;
      const span = await findQuoteSpan(env, detector, post, window.text);
      if (!span) return;
      mention.readAloudAt = Math.floor(timeAtOffset(window.offsets, span[0]) ?? run.start);
      mention.quote = expandSentence(window.text, span[0], span[1]);
    });
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
