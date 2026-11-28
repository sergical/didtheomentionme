import type { MediaContainer } from "./container";

export interface VideoParams {
  videoId: string;
  source: string;
}

/** JSON, as Workers AI takes and returns it. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type ModelInputs = { [key: string]: Json };

/** Workers AI as this app calls it. The binding's own types do not list these models. */
export interface ModelRunner {
  run(model: string, inputs: ModelInputs): Promise<Json>;
}

export interface Env {
  MEDIA: DurableObjectNamespace<MediaContainer>;
  BUCKET: R2Bucket;
  DB: D1Database;
  POSTS: VectorizeIndex;
  AI: ModelRunner;
  VIDEO_WORKFLOW: Workflow<VideoParams>;
  INTERNAL_TOKEN: string;
  /** Traces, logs and Issues go to this Sentry project over OTLP. No DSN turns telemetry off. */
  SENTRY_DSN?: string;
  /** The Sentry environment. The default is `production`. */
  SENTRY_ENVIRONMENT?: string;
  /** The didtheomentionme-container Sentry project. No DSN turns the container's Sentry off. */
  CONTAINER_SENTRY_DSN?: string;
}
