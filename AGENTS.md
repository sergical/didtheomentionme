# didtheomentionme

A Cloudflare Worker that finds the moments a creator showed or read an X post in a YouTube video, and serves the
lookup and explore pages at didtheomention.me. A container takes frames and audio from each video, and a Workflow
runs Workers AI models over them.

## Where things live

- `src/index.ts`: the Worker's routes and cron.
- `src/workflow.ts`, `src/steps.ts`, `src/job.ts`: the video Workflow and its extract job. `src/pipeline.ts`: its pure functions.
- `src/lookup.ts`, `src/explore.ts`, `src/videos.ts`: search, explore page data, the video queue.
- `src/ai.ts`: Workers AI calls. `src/runtime.ts`: D1, R2, Vectorize and HTTP calls, each with a span.
- `src/telemetry/`: spans and errors, sent to Sentry over OTLP.
- `src/ui/`: the Foldkit pages. `client.ts` is the browser entry, `render.ts` the server side.
- `container/`: the yt-dlp and ffmpeg container. `migrations/`: the D1 schema.
- `alchemy.run.ts`: the Cloudflare resources. `scripts/client.ts`: builds the browser script.
- `test/`: the `bun test` suites. `bindings.ts`, `d1.ts` and `harness.ts` there fake the Worker's bindings.
- `experiments/`: the scripts behind the model choices.
- `tools/oxlint/anti-slop/`: vendored lint rules. Update them from the source in its `UPSTREAM.md`.
- `docs/design.md`: how the pipeline works and why.

## Commands

- `pnpm install`
- `pnpm check`: lint, type check and tests, in that order.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`: one part of it.
- `LIVE_DSN=<dsn> pnpm test:live`: sends a fake run to a real Sentry project and makes an Issue there. Run it only when asked.
- `pnpm dev`, `pnpm plan`, `pnpm deploy`: Alchemy against Cloudflare. Run them only when asked.

## How a change is checked

- Run `pnpm check` before you push.
- `.github/workflows/check.yml` runs `pnpm check` on every pull request and on each push to `main`.
- The lint rules are in `.oxlintrc.json`. They cover every TypeScript file except the vendored rules in `tools/`.
- `tsconfig.json` checks `src/` against the Workers types. `tsconfig.bun.json` adds Bun's types and checks the rest.
