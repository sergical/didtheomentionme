# Did Theo mention me?

Find out if a creator showed or read your X post in one of their videos.

Live: https://didtheomention.me

- **Search** by X handle, post link, or words from the post. The result shows each moment the post was on screen, with
  a frame and a link to that second on YouTube, and the words the creator said if they read it aloud.
- **Explore** every scanned video, the most shown accounts, and when posts show up in a video:
  https://didtheomention.me/explore

It covers Theo (t3.gg) and ThePrimeagen. It is not affiliated with either of them.

## How it works

1. A cron job finds new videos from each creator's YouTube feed.
2. A Cloudflare Workflow sends each video to a Container, which downloads it, takes one frame per second with ffmpeg,
   and stores the frames and audio in R2.
3. Workers AI models find X posts in the frames and read the handle and text. A speech model makes a transcript, and
   the app checks which posts the creator read aloud.
4. Posts go into D1 (with full-text search) and Vectorize, so you can search by handle or by meaning.

The full design is in [docs/design.md](docs/design.md). The model choices come from the experiments in
[experiments/](experiments/).

## Run it

You need a Cloudflare account with Workers Paid (for Containers, Workflows and Workers AI), and
[pnpm](https://pnpm.io) and [Bun](https://bun.sh).

```sh
pnpm install
pnpm test          # bun test, on an in-memory SQLite copy of the D1 schema
pnpm typecheck
pnpm dev           # alchemy dev, on stage dev; restart it after a change in src/ui to rebuild the browser script
```

To deploy your own copy:

1. Connect Cloudflare: `pnpm exec alchemy profile edit --add Cloudflare`, or set `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_API_TOKEN`.
   Docker must run, because the deploy builds the container image.
2. Run `pnpm plan`, then `pnpm deploy` (both use the stage `prod`). [Alchemy](https://alchemy.run) creates or adopts every resource in
   `alchemy.run.ts` (Worker, D1 with its migrations, R2, Vectorize, Workflow, container), and applies new migrations.
   `--adopt` takes over resources that exist without Alchemy state, so a deploy also works from a new checkout.
3. Set the secret `INTERNAL_TOKEN` for the admin routes: `pnpm exec wrangler secret put INTERNAL_TOKEN --name
   didtheomentionme`. `SENTRY_DSN` is optional: with it, traces, logs and Issues go to that Sentry project over OTLP.
4. Fill the index: `POST /admin/backfill?source=theo&days=30` with `authorization: Bearer <INTERNAL_TOKEN>`.

To add a creator, add an entry to `SOURCES` in `src/config.ts`.

## License

[MIT](LICENSE)
