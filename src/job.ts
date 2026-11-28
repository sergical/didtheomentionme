/** The extract job of one video: what the container says about it, and how the workflow starts and checks it. */
import { Effect, Option, Schema } from "effect";
import { JOB_PROTOCOL, UPLOAD_HOST } from "./container";
import { annotate, r2, type App } from "./runtime";
import { containerFetch, destroyContainer, watchContainerJob } from "./videos";

/** What a finished job leaves in R2, as `run_job` in container/server.py writes it. */
const Manifest = Schema.Struct({
  videoId: Schema.String,
  title: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.Number),
  publishedAt: Schema.NullOr(Schema.String),
  frames: Schema.Number,
  /** Old manifests have a frame for every second, and no list. */
  keptSeconds: Schema.optional(Schema.mutable(Schema.Array(Schema.Number))),
  hasCaptions: Schema.Boolean,
  captionsError: Schema.optional(Schema.NullOr(Schema.String)),
  audioChunks: Schema.Union([Schema.Number, Schema.mutable(Schema.Array(Schema.String))]),
});

export type Manifest = typeof Manifest.Type;

/** The status of a job, from the container's `/jobs/<id>` or from the event it sends when the job ends. */
const JobStatus = Schema.Struct({
  state: Schema.Literals(["running", "done", "error", "stopped"]),
  stage: Schema.NullOr(Schema.String),
  restarted: Schema.optional(Schema.Boolean),
  uploaded: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
  error: Schema.NullOr(Schema.String),
  manifest: Schema.NullOr(Manifest),
});

export type JobStatus = typeof JobStatus.Type;

const decodeJobStatus = Schema.decodeUnknownOption(Schema.fromJsonString(JobStatus));

export function audioChunkCount(manifest: Manifest): number {
  return Array.isArray(manifest.audioChunks) ? manifest.audioChunks.length : manifest.audioChunks;
}

export const startJob = (videoId: string, instanceId: string, token: string) =>
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
export const checkJob = (videoId: string, instanceId: string, token: string): Effect.Effect<JobStatus, unknown, App> =>
  Effect.gen(function* () {
    const res = yield* containerFetch(videoId, `/jobs/${videoId}`);

    if (res.status === 404) {
      const manifestKey = `videos/${videoId}/manifest.json`;
      const object = yield* r2("GetObject", manifestKey, (bucket) => bucket.get(manifestKey));
      const manifest = object ? yield* Effect.promise(() => object.json<Manifest>()) : null;

      const done: JobStatus = { state: "done", stage: "done", error: null, manifest };

      if (manifest) return done;
      yield* startJob(videoId, instanceId, token);
      const restarted: JobStatus = { state: "running", stage: null, error: null, manifest: null, restarted: true };

      return restarted;
    }

    if (!res.ok) return yield* Effect.fail(new Error(`container GET /jobs: ${res.status}`));
    const body = yield* Effect.promise(() => res.text());
    const job = Option.getOrNull(decodeJobStatus(body));

    if (!job) return yield* Effect.fail(new Error(`container GET /jobs answered something else than a job status: ${body.slice(0, 200)}`));
    yield* annotate({ "container.state": job.state, "container.stage": job.stage ?? "", "container.uploaded": job.uploaded ?? 0, "container.upload_total": job.total ?? 0 });

    return job;
  });
