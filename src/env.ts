import type { MediaContainer } from "./container";

export interface VideoParams {
  videoId: string;
  source: string;
}

export interface Env {
  MEDIA: DurableObjectNamespace<MediaContainer>;
  BUCKET: R2Bucket;
  DB: D1Database;
  POSTS: VectorizeIndex;
  AI: Ai;
  VIDEO_WORKFLOW: Workflow<VideoParams>;
  INTERNAL_TOKEN: string;
  /** Traces, logs and Issues go to this Sentry project over OTLP. No DSN turns telemetry off. */
  SENTRY_DSN?: string;
  /** The Sentry environment. The default is `production`. */
  SENTRY_ENVIRONMENT?: string;
  /** The didtheomentionme-container Sentry project. No DSN turns the container's Sentry off. */
  CONTAINER_SENTRY_DSN?: string;
}
