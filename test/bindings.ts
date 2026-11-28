import { Schema } from "effect";
import type { Env, Json, ModelInputs, VideoParams } from "../src/env";
import { unused } from "./d1";

/** An R2 object as the app reads it. */
function stored(key: string, blob: Blob): R2ObjectBody {
  return {
    key,
    version: "1",
    size: blob.size,
    etag: "e",
    httpEtag: "e",
    checksums: { toJSON: () => ({}) },
    uploaded: new Date(),
    storageClass: "Standard",
    writeHttpMetadata: unused("writeHttpMetadata"),
    get body() {
      return blob.stream();
    },
    bodyUsed: false,
    arrayBuffer: () => blob.arrayBuffer(),
    bytes: async () => new Uint8Array(await blob.arrayBuffer()),
    text: () => blob.text(),
    json: async () => JSON.parse(await blob.text()),
    blob: async () => blob,
  };
}

/** An R2 bucket in memory. `list` gives pages in key order, and the cursor of a page is its last key. */
export function bucket(objects = new Map<string, Blob>()): R2Bucket {
  const find = (key: string) => {
    const blob = objects.get(key);

    return blob ? stored(key, blob) : null;
  };

  return {
    head: async (key) => find(key),
    get: async (key: string) => find(key),
    put: async (key: string, value: Parameters<R2Bucket["put"]>[1]) => {
      // A view can sit on shared memory, which a Response body cannot, so its bytes are copied.
      const blob = await new Response(ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice() : value).blob();
      objects.set(key, blob);

      return stored(key, blob);
    },
    delete: async (keys) => {
      for (const key of [keys].flat()) objects.delete(key);
    },
    list: async (options) => {
      const keys = [...objects.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).sort();
      const from = options?.cursor ? keys.indexOf(options.cursor) + 1 : 0;
      const page = keys.slice(from, from + (options?.limit ?? 1000));
      const listed = { objects: page.flatMap((key) => find(key) ?? []), delimitedPrefixes: [] };
      const cursor = page.at(-1);

      return cursor && from + page.length < keys.length ? { ...listed, truncated: true, cursor } : { ...listed, truncated: false };
    },
    createMultipartUpload: unused("createMultipartUpload"),
    resumeMultipartUpload: unused("resumeMultipartUpload"),
  };
}

/** The texts of an embedding request. */
export const textsAsked = (inputs: ModelInputs) => Schema.decodeUnknownSync(Schema.Struct({ text: Schema.Array(Schema.String) }))(inputs).text;

/** Workers AI, answered by `run`. */
export const ai = (run: (model: string, inputs: ModelInputs) => Json | Promise<Json>): Env["AI"] => ({ run: async (model, inputs) => run(model, inputs) });

/** A Vectorize index that finds `matches()`, best first, and takes every write. */
export function posts(matches: () => string[] = () => []): VectorizeIndex {
  return {
    query: async (_vector, options) => {
      const found = matches().slice(0, options?.topK).map((id) => ({ id, score: 0.95 }));

      return { matches: found, count: found.length };
    },
    upsert: async (vectors) => ({ ids: vectors.map((vector) => vector.id), count: vectors.length }),
    deleteByIds: async (ids) => ({ ids, count: ids.length }),
    describe: unused("describe"),
    insert: unused("insert"),
    getByIds: unused("getByIds"),
  };
}

type Status = InstanceStatus["status"];

/** The Workflows binding: `instances` holds the status of each instance that exists, and `create` adds one. */
export function workflows(instances: Map<string, Status>, create: (id: string, params: VideoParams) => void | Promise<void> = (id) => void instances.set(id, "queued")): Env["VIDEO_WORKFLOW"] {
  const instance = (id: string): WorkflowInstance => ({
    id,
    status: async () => ({ status: instances.get(id) ?? "unknown" }),
    pause: unused("pause"),
    resume: unused("resume"),
    terminate: unused("terminate"),
    restart: unused("restart"),
    delete: unused("delete"),
    sendEvent: unused("sendEvent"),
    subscribe: unused("subscribe"),
  });

  return {
    get: async (id) => {
      if (!instances.has(id)) throw new Error("instance.not_found");

      return instance(id);
    },
    create: async (options) => {
      if (!options?.id || !options.params) throw new Error("the app starts every instance with an id and params");
      await create(options.id, options.params);

      return instance(options.id);
    },
    createBatch: unused("createBatch"),
    deleteBatch: unused("deleteBatch"),
  };
}

/** Every binding, where each one a test does not pass fails the test when the code under test calls it. */
export function env(parts: Partial<Env> = {}): Env {
  return {
    MEDIA: {
      newUniqueId: unused("MEDIA"),
      idFromName: unused("MEDIA"),
      idFromString: unused("MEDIA"),
      get: unused("MEDIA"),
      getByName: unused("MEDIA"),
      jurisdiction: unused("MEDIA"),
    },
    BUCKET: {
      head: unused("BUCKET"),
      get: unused("BUCKET"),
      put: unused("BUCKET"),
      delete: unused("BUCKET"),
      list: unused("BUCKET"),
      createMultipartUpload: unused("BUCKET"),
      resumeMultipartUpload: unused("BUCKET"),
    },
    DB: { prepare: unused("DB"), batch: unused("DB"), exec: unused("DB"), withSession: unused("DB"), dump: unused("DB") },
    POSTS: { query: unused("POSTS"), upsert: unused("POSTS"), deleteByIds: unused("POSTS"), describe: unused("POSTS"), insert: unused("POSTS"), getByIds: unused("POSTS") },
    AI: { run: unused("AI") },
    VIDEO_WORKFLOW: { get: unused("VIDEO_WORKFLOW"), create: unused("VIDEO_WORKFLOW"), createBatch: unused("VIDEO_WORKFLOW"), deleteBatch: unused("VIDEO_WORKFLOW") },
    INTERNAL_TOKEN: "t",
    ...parts,
  };
}
