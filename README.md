# Did Theo mention me?

Find out if a creator showed or read your X post in one of their videos.

Live: https://didtheomentionme.s-a62.workers.dev

- **Search** by X handle, post link, or words from the post. The result shows each moment the post was on screen, with
  a frame and a link to that second on YouTube, and the words the creator said if they read it aloud.
- **Explore** every scanned video, the most shown accounts, and when posts show up in a video:
  https://didtheomentionme.s-a62.workers.dev/explore

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
```

To deploy your own copy:

1. Create the resources named in `wrangler.jsonc`: the D1 database, the R2 bucket, and the Vectorize index
   (1024 dimensions, cosine).
2. Apply the migrations: `pnpm exec wrangler d1 migrations apply didtheomentionme --remote`.
3. Set the secret `INTERNAL_TOKEN` for the admin routes. `SENTRY_DSN` is optional.
4. Run `pnpm exec wrangler deploy`. To deploy Worker code without a new container image, add
   `--containers-rollout=none`.
5. Fill the index: `POST /admin/backfill?source=theo&days=30` with `authorization: Bearer <INTERNAL_TOKEN>`.

To add a creator, add an entry to `SOURCES` in `src/config.ts`.

## License

[MIT](LICENSE)
