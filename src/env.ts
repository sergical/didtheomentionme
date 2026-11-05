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
  SENTRY_DSN?: string;
  /** The didtheomentionme-container Sentry project. No DSN turns the container's Sentry off. */
  CONTAINER_SENTRY_DSN?: string;
}
