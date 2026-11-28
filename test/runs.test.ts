import type { Database } from "bun:sqlite";
import { beforeEach, expect, mock, test } from "bun:test";
import type { Env } from "../src/env";
import { d1, migrated } from "./d1";

mock.module("@cloudflare/containers", () => ({ Container: class {}, ContainerProxy: class {}, getContainer: () => ({}) }));

const { endRun, reconcileProcessing, startPending, startRun, startWorkflow } = await import("../src/videos");
const { runApp } = await import("../src/runtime");

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
  await runApp(env(), startRun("abc", "abc"));
  await runApp(env(), endRun("abc", "error", "metadata failed"));
  await runApp(env(), startRun("abc", "abc_1"));
  await runApp(env(), endRun("abc_1", "bot_check"));
  await runApp(env(), startRun("abc", "abc_2"));
  await runApp(env(), endRun("abc_2", "done"));
  expect(runs("abc")).toEqual([
    { instance_id: "abc", outcome: "error", reason: "metadata failed" },
    { instance_id: "abc_1", outcome: "bot_check", reason: null },
    { instance_id: "abc_2", outcome: "done", reason: null },
  ]);
});

test("a retried step does not overwrite the recorded outcome", async () => {
  await runApp(env(), startRun("abc", "abc"));
  await runApp(env(), startRun("abc", "abc"));
  await runApp(env(), endRun("abc", "done"));
  await runApp(env(), endRun("abc", "error", "late retry"));
  expect(runs("abc")).toEqual([{ instance_id: "abc", outcome: "done", reason: null }]);
});

test("reconcile ends the run of a workflow that finished without a final status", async () => {
  db.query("INSERT INTO videos (id, source, status, updated_at) VALUES ('abc', 'theo', 'processing', ?)").run(new Date().toISOString());
  await runApp(env(), startRun("abc", "abc"));
  await runApp(env(), endRun("abc", "bot_check"));
  await runApp(env(), startRun("abc", "abc_1"));
  instances = { abc: "complete", abc_1: "terminated" };
  await runApp(env(), reconcileProcessing);
  expect(runs("abc")).toEqual([
    { instance_id: "abc", outcome: "bot_check", reason: null },
    { instance_id: "abc_1", outcome: "error", reason: "workflow ended without a final status" },
  ]);
  expect(db.query("SELECT status FROM videos WHERE id = 'abc'").get()).toEqual({ status: "error" });
});

test("a failed run close is retried on the next reconcile", async () => {
  db.query("INSERT INTO videos (id, source, status, updated_at) VALUES ('abc', 'theo', 'processing', ?)").run(new Date().toISOString());
  await runApp(env(), startRun("abc", "abc"));
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
  await runApp(flaky, reconcileProcessing);
  await runApp(env(), reconcileProcessing);
  expect(runs("abc")).toEqual([{ instance_id: "abc", outcome: "error", reason: "workflow ended without a final status" }]);
  expect(db.query("SELECT status FROM videos WHERE id = 'abc'").get()).toEqual({ status: "error" });
});

const openRun = (instanceId: string, minutesAgo: number) =>
  db.query("INSERT INTO video_runs (instance_id, video_id, started_at) VALUES (?, 'abc', ?)")
    .run(instanceId, new Date(Date.now() - minutesAgo * 60_000).toISOString());

test("each start gets a new instance id, also after Workflows drops the old instance", async () => {
  await runApp(env(), startRun("abc", "abc"));
  await runApp(env(), endRun("abc", "done"));
  expect(await runApp(env(), startWorkflow("abc", "theo"))).toBe("started");
  const [old, next] = runs("abc") as { instance_id: string }[];
  expect(old.instance_id).toBe("abc");
  expect(next.instance_id).toMatch(/^abc_[0-9a-z]{8}[0-9a-f]{4}$/);
  expect(Object.keys(instances)).toEqual([next.instance_id]);
});

test("concurrent starts of one video create one workflow", async () => {
  const results = await Promise.all([runApp(env(), startWorkflow("abc", "theo")), runApp(env(), startWorkflow("abc", "theo"))]);
  expect(results.sort()).toEqual(["running", "started"]);
  expect(Object.keys(instances)).toHaveLength(1);
  expect(await runApp(env(), startWorkflow("abc", "theo"))).toBe("running");
});

test("a new run whose instance is not created yet counts as running", async () => {
  openRun("abc_new", 1);
  expect(await runApp(env(), startWorkflow("abc", "theo"))).toBe("running");
  expect(runs("abc")).toEqual([{ instance_id: "abc_new", outcome: null, reason: null }]);
});

test("a start closes an old run whose workflow is gone", async () => {
  openRun("abc_old", 30);
  expect(await runApp(env(), startWorkflow("abc", "theo"))).toBe("started");
  expect(runs("abc")).toContainEqual({ instance_id: "abc_old", outcome: "error", reason: "workflow ended without a final status" });
});

test("a failed instance lookup leaves the run open and starts nothing", async () => {
  openRun("abc_old", 30);
  const flaky = env();
  flaky.VIDEO_WORKFLOW.get = async () => {
    throw new Error("Workflows unavailable");
  };

  await expect(runApp(flaky, startWorkflow("abc", "theo"))).rejects.toThrow("Workflows unavailable");
  expect(runs("abc")).toEqual([{ instance_id: "abc_old", outcome: null, reason: null }]);
});

test("a failed create closes its run, so the next start can try again", async () => {
  create = async () => {
    throw new Error("Workflows unavailable");
  };

  await expect(runApp(env(), startWorkflow("-abc", "theo"))).rejects.toThrow("Workflows unavailable");
  const [run] = runs("-abc") as { instance_id: string; outcome: string; reason: string }[];
  expect(run.instance_id).toMatch(/^v-abc_/);
  expect([run.outcome, run.reason]).toEqual(["error", "workflow start failed: Workflows unavailable"]);
});

test("a failed instance lookup marks that video and still starts the next one", async () => {
  const now = new Date().toISOString();
  db.query("INSERT INTO videos (id, source, published_at, status, updated_at) VALUES ('abc', 'theo', '2026-11-02', 'pending', ?), ('def', 'theo', '2026-11-01', 'pending', ?)").run(now, now);
  openRun("abc_old", 30);
  const flaky = env();
  const get = flaky.VIDEO_WORKFLOW.get;
  flaky.VIDEO_WORKFLOW.get = async (id: string) => {
    if (id === "abc_old") throw new Error("Workflows unavailable");

    return get(id);
  };

  expect(await runApp(flaky, startPending)).toBe(1);
  expect(db.query("SELECT id, status, error FROM videos ORDER BY id").all()).toEqual([
    { id: "abc", status: "error", error: "workflow start failed: Workflows unavailable" },
    { id: "def", status: "processing", error: null },
  ]);
});
