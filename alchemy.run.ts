import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

/**
 * The Cloudflare resources of the app. In the stage `prod`, every name is the name of a live resource, so a deploy
 * adopts it instead of making a new one; changing a name replaces that resource with an empty one. Any other stage
 * (`alchemy dev` uses one) gets its own names and no custom domain, so it never touches the live resources.
 *
 * The secrets INTERNAL_TOKEN, SENTRY_DSN and CONTAINER_SENTRY_DSN are set with `wrangler secret put`. Alchemy keeps
 * secrets that it does not manage.
 */

const stage = process.env.ALCHEMY_STAGE ?? "dev";
const prod = stage === "prod";
const named = (name: string) => (prod ? name : `${name}-${stage}`);

/** The yt-dlp and ffmpeg container, and the Durable Object namespace `MEDIA` that runs it. */
const Media = Cloudflare.Container("MEDIA", {
  className: "MediaContainer",
  name: named("didtheomentionme-mediacontainer"),
  context: "./container",
  instanceType: "standard-2",
  maxInstances: 4,
});

export const Worker = Cloudflare.Worker("Worker", {
  name: named("didtheomentionme"),
  main: "./src/index.ts",
  compatibility: { date: "2026-10-15", flags: ["nodejs_compat"] },
  observability: { enabled: true },
  workersDev: true,
  domain: prod ? "didtheomention.me" : undefined,
  crons: ["*/10 * * * *"],
  // After its last sleep, a workflow runs detection in one invocation: about 2 subrequests per video second.
  // Encoding those frames passed the default CPU limit when two long videos ran, and a retry repeats the paid calls.
  limits: { cpuMs: 300_000, subrequests: 100_000 },
  env: {
    AI: Cloudflare.Workers.AI(),
    BUCKET: Cloudflare.R2.Bucket("Bucket", { name: named("didtheomentionme-media") }),
    DB: Cloudflare.D1.Database("Database", { name: named("didtheomentionme"), migrations: "./migrations" }),
    POSTS: Cloudflare.Vectorize.Index("Posts", { name: named("didtheomentionme-posts"), dimensions: 1024, metric: "cosine" }),
    VIDEO_WORKFLOW: Cloudflare.Workflow("VideoWorkflow", { workflowName: named("video-workflow") }),
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
