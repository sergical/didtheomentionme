import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

/**
 * The Cloudflare resources of the app. Every name below is the name of a live resource, so a deploy adopts it
 * instead of making a new one. Changing a name replaces that resource with an empty one.
 *
 * The secrets INTERNAL_TOKEN, SENTRY_DSN and CONTAINER_SENTRY_DSN are set with `wrangler secret put`. Alchemy keeps
 * secrets that it does not manage.
 */

/** The yt-dlp and ffmpeg container, and the Durable Object namespace `MEDIA` that runs it. */
const Media = Cloudflare.Container("MEDIA", {
  className: "MediaContainer",
  name: "didtheomentionme-mediacontainer",
  context: "./container",
  instanceType: "standard-2",
  maxInstances: 4,
});

export const Worker = Cloudflare.Worker("Worker", {
  name: "didtheomentionme",
  main: "./src/index.ts",
  compatibility: { date: "2026-10-15", flags: ["nodejs_compat"] },
  observability: { enabled: true },
  workersDev: true,
  domain: "didtheomention.me",
  crons: ["*/10 * * * *"],
  // After its last sleep, a workflow runs detection in one invocation: about 2 subrequests per video second.
  // Encoding those frames passed the default CPU limit when two long videos ran, and a retry repeats the paid calls.
  limits: { cpuMs: 300_000, subrequests: 100_000 },
  env: {
    AI: Cloudflare.Workers.AI(),
    BUCKET: Cloudflare.R2.Bucket("Bucket", { name: "didtheomentionme-media" }),
    DB: Cloudflare.D1.Database("Database", { name: "didtheomentionme", migrations: "./migrations" }),
    POSTS: Cloudflare.Vectorize.Index("Posts", { name: "didtheomentionme-posts", dimensions: 1024, metric: "cosine" }),
    VIDEO_WORKFLOW: Cloudflare.Workflow("VideoWorkflow", { workflowName: "video-workflow" }),
    MEDIA: Media,
  },
});

export default Alchemy.Stack(
  "didtheomentionme",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
