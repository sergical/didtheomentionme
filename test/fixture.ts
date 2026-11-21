import { mock } from "bun:test";
import type { Env } from "../src/env";
import { d1, migrated } from "./d1";
import { engine, settle } from "./harness";

// The Workers runtime modules, as far as the pipeline uses them.
mock.module("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));
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

/** An R2 bucket in memory. */
function bucket(objects: Map<string, string | ArrayBuffer>) {
  const body = (key: string) => {
    const value = objects.get(key)!;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value).buffer : value;
    return { key, httpEtag: "e", body: null, arrayBuffer: async () => bytes, json: async () => JSON.parse(value as string), text: async () => value };
  };
  return {
    get: async (key: string) => (objects.has(key) ? body(key) : null),
    head: async (key: string) => (objects.has(key) ? { key } : null),
    put: async (key: string, value: string | ArrayBuffer) => void objects.set(key, value),
    delete: async (keys: string | string[]) => void [keys].flat().forEach((k) => objects.delete(k)),
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: new Date() })), truncated: false }),
    createMultipartUpload: async () => ({}),
    resumeMultipartUpload: () => ({}),
  };
}

/** Workers AI answers for a post on screen from second 5 to 8, which the creator reads aloud. */
const ai = {
  run: async (model: string, inputs: any) => {
    const usage = { prompt_tokens: 100, completion_tokens: 10 };
    if (model.includes("clef-flash")) {
      // A frame's byte length is 3 × its second, so base64 holds 4 characters per second.
      const second = String(inputs.images[0].base64).length / 4;
      const onScreen = second >= 5 && second <= 8;
      return { answers: { frame: { noul: onScreen ? 0.9 : 0.1 }, page: { noul: 0.9 }, chat: { noul: 0.1 } }, usage };
    }
    if (model.includes("qwen")) return { choices: [{ message: { content: inputs.max_tokens === 5 ? "X" : `@alice | Alice | ${POST}` }, finish_reason: "stop" }], usage };
    if (model === "@cf/cloudflare/clef") return { answers: { read: { noul: 0.9 } }, usage };
    if (model.includes("clairic")) return { answers: { quote: { span: [11, 11 + POST.length] } }, usage };
    if (model.includes("bge-m3")) return { data: inputs.text.map(() => [0.1, 0.2]) };
    throw new Error(`unexpected model ${model}`);
  },
};

/** The bindings of one fake run. With `failProcessing`, every write of the `processing` status fails. */
export function env(dsn: string, environment?: string, failProcessing = false): Env & { sqlite: ReturnType<typeof migrated> } {
  const objects = new Map<string, string | ArrayBuffer>();
  for (let s = 0; s < FRAMES; s++) {
    objects.set(`videos/${VIDEO}/f640/${s}.jpg`, new Uint8Array(s * 3).buffer as ArrayBuffer);
    objects.set(`videos/${VIDEO}/f1920/${s}.jpg`, new Uint8Array(s * 3).buffer as ArrayBuffer);
  }
  const words = ["alice", "says", ...POST.split(" "), "and", "i", "agree"].map((w, i) => [5 + i * 0.3, w]);
  objects.set(`videos/${VIDEO}/words.json`, JSON.stringify(words));
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
  return {
    sqlite: db,
    SENTRY_DSN: dsn,
    SENTRY_ENVIRONMENT: environment,
    INTERNAL_TOKEN: "t",
    DB: binding,
    BUCKET: bucket(objects),
    AI: ai,
    POSTS: { query: async () => ({ matches: [] }), upsert: async () => ({}), deleteByIds: async () => ({}) },
    MEDIA: {},
    VIDEO_WORKFLOW: {},
  } as unknown as Env & { sqlite: ReturnType<typeof migrated> };
}

/** Runs one video through the real pipeline: a first invocation that waits for the extract event, then a replay. */
export async function runVideo(options: { dsn: string; environment?: string; job?: unknown; instanceId?: string; failProcessing?: boolean }) {
  const { job = done } = options;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  const Workflow = VideoPipeline as unknown as new (...args: unknown[]) => { run(event: unknown, step: unknown): Promise<void> };
  const step = engine([], { "extract-done": job });
  const event = { instanceId: options.instanceId ?? `${VIDEO}_run`, payload: { videoId: VIDEO, source: "theo" }, timestamp: new Date() };
  const e = env(options.dsn, options.environment, options.failProcessing);
  // The first invocation suspends at the extract event; the second replays the cached steps and finishes.
  // A run that fails before the event ends in this first invocation, so its rejection is expected.
  void new Workflow(ctx, e).run(event, step).catch(() => {});
  await settle(300);
  const result = await new Workflow(ctx, e).run(event, step).then(() => ({ completed: true as const }), (error: unknown) => ({ completed: false as const, error }));
  await Promise.all(pending);
  await settle(1500);
  return { ...result, db: e.sqlite };
}

