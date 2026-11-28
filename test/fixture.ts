import { mock } from "bun:test";
import { Schema } from "effect";
import type { Env, Json } from "../src/env";
import { ai, bucket, env as bindings, posts, textsAsked } from "./bindings";
import { d1, migrated } from "./d1";
import { engine, settle } from "./harness";

// The Workers runtime modules, as far as the pipeline uses them.
mock.module("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

mock.module("cloudflare:workflows", () => ({ NonRetryableError: class NonRetryableError extends Error { name = "NonRetryableError"; } }));

export const VIDEO = "vid00000001";
const FRAMES = 20;
const POST = "effect makes telemetry simple for everyone";
const manifest = { videoId: VIDEO, title: "A video", duration: 200, publishedAt: "2026-11-01T00:00:00Z", frames: FRAMES, hasCaptions: true, audioChunks: 0 };
export const done = { state: "done", stage: "done", error: null, manifest };

mock.module("@cloudflare/containers", () => ({
  Container: class {},
  ContainerProxy: class {},
  getContainer: () => ({
    watchJob: async () => {},
    destroy: async () => {},
    fetch: async (_url: string, init?: RequestInit) => (init?.method === "POST" ? Response.json({ protocol: 3 }) : Response.json(done)),
  }),
}));

const { VideoPipeline } = await import("../src/workflow");

const frameAsked = Schema.decodeUnknownSync(Schema.Struct({ images: Schema.Tuple([Schema.Struct({ base64: Schema.String })]) }));
const readerAsked = Schema.decodeUnknownSync(Schema.Struct({ max_tokens: Schema.Number }));

/** Workers AI answers for a post on screen from second 5 to 8, which the creator reads aloud. */
const answers = ai((model, inputs): Json => {
  const usage = { prompt_tokens: 100, completion_tokens: 10 };

  if (model.includes("clef-flash")) {
    // A frame's byte length is 3 × its second, so base64 holds 4 characters per second.
    const second = frameAsked(inputs).images[0].base64.length / 4;
    const onScreen = second >= 5 && second <= 8;

    return { answers: { frame: { noul: onScreen ? 0.9 : 0.1 }, page: { noul: 0.9 }, chat: { noul: 0.1 } }, usage };
  }

  if (model.includes("qwen")) return { choices: [{ message: { content: readerAsked(inputs).max_tokens === 5 ? "X" : `@alice | Alice | ${POST}` }, finish_reason: "stop" }], usage };

  if (model === "@cf/cloudflare/clef") return { answers: { read: { noul: 0.9 } }, usage };

  if (model.includes("clairic")) return { answers: { quote: { span: [11, 11 + POST.length] } }, usage };

  if (model.includes("bge-m3")) return { data: textsAsked(inputs).map(() => [0.1, 0.2]) };
  throw new Error(`unexpected model ${model}`);
});

/** The bindings of one fake run. With `failProcessing`, every write of the `processing` status fails. */
export function env(dsn: string, environment?: string, failProcessing = false): Env & { sqlite: ReturnType<typeof migrated> } {
  const objects = new Map<string, Blob>();

  for (let s = 0; s < FRAMES; s++) {
    objects.set(`videos/${VIDEO}/f640/${s}.jpg`, new Blob([new Uint8Array(s * 3)]));
    objects.set(`videos/${VIDEO}/f1920/${s}.jpg`, new Blob([new Uint8Array(s * 3)]));
  }

  const words = ["alice", "says", ...POST.split(" "), "and", "i", "agree"].map((w, i) => [5 + i * 0.3, w]);
  objects.set(`videos/${VIDEO}/words.json`, new Blob([JSON.stringify(words)]));
  const db = migrated();
  db.query("INSERT INTO videos (id, source, status, updated_at) VALUES (?, 'theo', 'pending', ?)").run(VIDEO, new Date().toISOString());
  const binding = d1(db);
  const prepare = binding.prepare;
  binding.prepare = (sql: string) => {
    const statement = prepare(sql);

    if (!failProcessing || !sql.startsWith("UPDATE videos SET status")) return statement;
    const bind = statement.bind;
    statement.bind = (...values: unknown[]) => {
      if (values[0] === "processing") statement.run = async () => { throw new Error("D1 unavailable"); };

      return bind(...values);
    };

    return statement;
  };

  return { ...bindings({ DB: binding, BUCKET: bucket(objects), AI: answers, POSTS: posts() }), SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: environment, sqlite: db };
}

/** Runs one video through the real pipeline: a first invocation that waits for the extract event, then a replay. */
export async function runVideo(options: { dsn: string; environment?: string; job?: Json; instanceId?: string; failProcessing?: boolean }) {
  const step = engine([], new Map([["extract-done", options.job ?? done]]));
  const event = { instanceId: options.instanceId ?? `${VIDEO}_run`, payload: { videoId: VIDEO, source: "theo" } };
  const e = env(options.dsn, options.environment, options.failProcessing);
  // The first invocation suspends at the extract event; the second replays the cached steps and finishes.
  // A run that fails before the event ends in this first invocation, so its rejection is expected.
  void new VideoPipeline(e).run(event, step).catch(() => {});
  await settle(300);
  const result = await new VideoPipeline(e).run(event, step).then(() => ({ completed: true as const }), (cause: unknown) => ({ completed: false as const, error: cause }));
  await settle(1500);

  return { ...result, db: e.sqlite };
}
