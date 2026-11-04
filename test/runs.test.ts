import type { Database } from "bun:sqlite";
import { beforeEach, expect, mock, test } from "bun:test";
import type { Env } from "../src/env";
import { d1, migrated } from "./d1";

mock.module("@cloudflare/containers", () => ({ getContainer: () => ({}) }));
const { endRun, reconcileProcessing, startRun, startWorkflow } = await import("../src/videos");

let db: Database;
let instances: Record<string, string> = {};
let create: (id: string) => Promise<void>;

function env(): Env {
  return {
    DB: d1(db),
    VIDEO_WORKFLOW: {
      get: async (id: string) => {
        if (!(id in instances)) throw new Error("instance.not_found");
        return { id, status: async () => ({ status: instances[id] }) };
      },
      create: async ({ id }: { id: string }) => create(id),
    },
  } as unknown as Env;
}

const runs = (videoId: string) =>
  db.query("SELECT instance_id, outcome, reason FROM video_runs WHERE video_id = ? ORDER BY instance_id").all(videoId);

beforeEach(() => {
  db = migrated();
  instances = {};
  create = async (id) => {
    instances[id] = "queued";
  };
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
  await endRun(env(), "abc", "bot_check");
  await startRun(env(), "abc", "abc_1");
  instances = { abc: "complete", abc_1: "terminated" };
  await reconcileProcessing(env());
  expect(runs("abc")).toEqual([
    { instance_id: "abc", outcome: "bot_check", reason: null },
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

const openRun = (instanceId: string, minutesAgo: number) =>
  db.query("INSERT INTO video_runs (instance_id, video_id, started_at) VALUES (?, 'abc', ?)")
    .run(instanceId, new Date(Date.now() - minutesAgo * 60_000).toISOString());

test("each start gets a new instance id, also after Workflows drops the old instance", async () => {
  await startRun(env(), "abc", "abc");
  await endRun(env(), "abc", "done");
  expect(await startWorkflow(env(), "abc", "theo")).toBe("started");
  const [old, next] = runs("abc") as { instance_id: string }[];
  expect(old.instance_id).toBe("abc");
  expect(next.instance_id).toMatch(/^abc_[0-9a-z]{8}[0-9a-f]{4}$/);
  expect(Object.keys(instances)).toEqual([next.instance_id]);
});

test("concurrent starts of one video create one workflow", async () => {
  const results = await Promise.all([startWorkflow(env(), "abc", "theo"), startWorkflow(env(), "abc", "theo")]);
  expect(results.sort()).toEqual(["running", "started"]);
  expect(Object.keys(instances)).toHaveLength(1);
  expect(await startWorkflow(env(), "abc", "theo")).toBe("running");
});

test("a new run whose instance is not created yet counts as running", async () => {
  openRun("abc_new", 1);
  expect(await startWorkflow(env(), "abc", "theo")).toBe("running");
  expect(runs("abc")).toEqual([{ instance_id: "abc_new", outcome: null, reason: null }]);
});

test("a start closes an old run whose workflow is gone", async () => {
  openRun("abc_old", 30);
  expect(await startWorkflow(env(), "abc", "theo")).toBe("started");
  expect(runs("abc")).toContainEqual({ instance_id: "abc_old", outcome: "error", reason: "workflow ended without a final status" });
});

test("a failed instance lookup leaves the run open and starts nothing", async () => {
  openRun("abc_old", 30);
  const flaky = env();
  flaky.VIDEO_WORKFLOW.get = async () => {
    throw new Error("Workflows unavailable");
  };
  await expect(startWorkflow(flaky, "abc", "theo")).rejects.toThrow("Workflows unavailable");
  expect(runs("abc")).toEqual([{ instance_id: "abc_old", outcome: null, reason: null }]);
});

test("a failed create closes its run, so the next start can try again", async () => {
  create = async () => {
    throw new Error("Workflows unavailable");
  };
  await expect(startWorkflow(env(), "-abc", "theo")).rejects.toThrow("Workflows unavailable");
  const [run] = runs("-abc") as { instance_id: string; outcome: string; reason: string }[];
  expect(run.instance_id).toMatch(/^v-abc_/);
  expect([run.outcome, run.reason]).toEqual(["error", "workflow start failed: Workflows unavailable"]);
});
