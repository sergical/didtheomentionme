import { describe, test } from "bun:test";
import { VIDEO, runVideo } from "./fixture";

/**
 * Sends one fake video run, and one failed run, to a real Sentry project, in the environment `live-check`. Runs
 * only with `LIVE_DSN`. The failed run makes a real Issue.
 */
describe.skipIf(!process.env.LIVE_DSN)("live check", () => {
  const dsn = process.env.LIVE_DSN!;
  const stamp = Date.now().toString(36);
  test("sends a run and a failed run", async () => {
    await runVideo({ dsn, environment: "live-check", instanceId: `${VIDEO}_live_${stamp}` });
    const job = { state: "error", stage: "metadata", error: `live check ${stamp}: This video is unavailable`, manifest: null };
    await runVideo({ dsn, environment: "live-check", job, instanceId: `${VIDEO}_live_fail_${stamp}` });
    console.log("instances", `${VIDEO}_live_${stamp}`, `${VIDEO}_live_fail_${stamp}`);
  }, 60_000);
});
