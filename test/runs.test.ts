import type { Database } from "bun:sqlite";
import { beforeEach, expect, mock, test } from "bun:test";
import type { Env } from "../src/env";
import { d1, migrated } from "./d1";

mock.module("@cloudflare/containers", () => ({ getContainer: () => ({}) }));
const { endRun, reconcileProcessing, startRun } = await import("../src/videos");

let db: Database;
let instances: Record<string, string> = {};

function env(): Env {
  return {
    DB: d1(db),
    VIDEO_WORKFLOW: {
      get: async (id: string) => {
        if (!(id in instances)) throw new Error("not found");
        return { id, status: async () => ({ status: instances[id] }) };
      },
    },
  } as unknown as Env;
}

const runs = (videoId: string) =>
  db.query("SELECT instance_id, outcome, reason FROM video_runs WHERE video_id = ? ORDER BY instance_id").all(videoId);

beforeEach(() => {
  db = migrated();
  instances = {};
});

test("a later success keeps the earlier failure", async () => {
  await startRun(env(), "abc", "abc");
  await endRun(env(), "abc", "error", "metadata failed");
  await startRun(env(), "abc", "abc_1");
  await endRun(env(), "abc_1", "bot_check");
  await startRun(env(), "abc", "abc_2");
  await endRun(env(), "abc_2", "done");
  expect(runs("abc")).toEqual([
    { instance_id: "abc", outcome: "error", reason: "metadata failed" },
    { instance_id: "abc_1", outcome: "bot_check", reason: null },
    { instance_id: "abc_2", outcome: "done", reason: null },
  ]);
});

test("a retried step does not overwrite the recorded outcome", async () => {
  await startRun(env(), "abc", "abc");
  await startRun(env(), "abc", "abc");
  await endRun(env(), "abc", "done");
  await endRun(env(), "abc", "error", "late retry");
  expect(runs("abc")).toEqual([{ instance_id: "abc", outcome: "done", reason: null }]);
});

test("reconcile ends the run of a workflow that finished without a final status", async () => {
  db.query("INSERT INTO videos (id, source, status, updated_at) VALUES ('abc', 'theo', 'processing', ?)").run(new Date().toISOString());
  await startRun(env(), "abc", "abc");
  await startRun(env(), "abc", "abc_1");
  instances = { abc: "errored", abc_1: "terminated" };
  await reconcileProcessing(env());
  expect(runs("abc")).toEqual([
    { instance_id: "abc", outcome: null, reason: null },
    { instance_id: "abc_1", outcome: "error", reason: "workflow ended without a final status" },
  ]);
  expect(db.query("SELECT status FROM videos WHERE id = 'abc'").get()).toEqual({ status: "error" });
});

test("a failed run close is retried on the next reconcile", async () => {
  db.query("INSERT INTO videos (id, source, status, updated_at) VALUES ('abc', 'theo', 'processing', ?)").run(new Date().toISOString());
  await startRun(env(), "abc", "abc");
  instances = { abc: "errored" };
  const flaky = env();
  const prepare = flaky.DB.prepare.bind(flaky.DB);
  let failed = false;
  flaky.DB.prepare = ((sql: string) => {
    if (!failed && sql.startsWith("UPDATE video_runs")) {
      failed = true;
      throw new Error("D1 unavailable");
    }
    return prepare(sql);
  }) as typeof flaky.DB.prepare;
  await reconcileProcessing(flaky);
  await reconcileProcessing(env());
  expect(runs("abc")).toEqual([{ instance_id: "abc", outcome: "error", reason: "workflow ended without a final status" }]);
  expect(db.query("SELECT status FROM videos WHERE id = 'abc'").get()).toEqual({ status: "error" });
});
