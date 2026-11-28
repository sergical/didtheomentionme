import { expect, test } from "bun:test";
import { VIDEO, runVideo } from "./fixture";
import { replaceFetch } from "./harness";

/**
 * Sends one fake video run and one failed run to a real Sentry project, in the environment `live-check`, and checks
 * that Sentry accepted the traces, the logs and the Issue. The failed run makes a real Issue, so `bun test` leaves
 * this file out: run it with `LIVE_DSN=<dsn> pnpm test:live`.
 */
test("Sentry accepts a run's traces and logs, and a failed run's Issue", async () => {
  const dsn = Bun.env.LIVE_DSN;

  if (!dsn) throw new Error("set LIVE_DSN to the DSN of the Sentry project to send to");
  const stamp = Date.now().toString(36);
  const answers: { path: string; status: number }[] = [];
  // Set before the first export, because Effect's fetch client keeps the `fetch` it finds first.
  const send = globalThis.fetch;
  replaceFetch(async ({ url }, next) => {
    const path = new URL(url).pathname.split("/").filter(Boolean).slice(2).join("/");
    const toSentry = url.startsWith(new URL(dsn).origin);

    try {
      const res = await next();

      if (toSentry) answers.push({ path, status: res.status });

      return res;
    } catch (err) {
      // A request that never got an answer counts as failed, with status 0.
      if (toSentry) answers.push({ path, status: 0 });
      throw err;
    }
  });

  const run = await runVideo({ dsn, environment: "live-check", instanceId: `${VIDEO}_live_${stamp}` });
  const job = { state: "error", stage: "metadata", error: `live check ${stamp}: This video is unavailable`, manifest: null };
  const failed = await runVideo({ dsn, environment: "live-check", job, instanceId: `${VIDEO}_live_fail_${stamp}` });
  globalThis.fetch = send;

  expect(run.completed).toBe(true);
  expect(failed.completed).toBe(false);
  expect(answers.filter((a) => a.status === 0 || a.status >= 300)).toEqual([]);
  const counts = new Map<string, number>();

  for (const { path, status } of answers) counts.set(`${path} ${status}`, (counts.get(`${path} ${status}`) ?? 0) + 1);
  console.log("Sentry answers", JSON.stringify(Object.fromEntries(counts)));
  const sent = (path: string) => answers.filter((a) => a.path === path).length;
  expect(sent("integration/otlp/v1/traces")).toBeGreaterThan(0);
  expect(sent("integration/otlp/v1/logs")).toBeGreaterThan(0);
  expect(sent("envelope")).toBe(1);
}, 60_000);
