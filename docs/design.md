# didtheomentionme: design

Did a creator (Theo) show or read your X post in a video? A visitor enters an X handle, and optionally a post URL.
The app answers from an index of the creator's videos from the last 30 days.

Deployed at https://didtheomention.me (also https://didtheomentionme.s-a62.workers.dev). Run `pnpm exec wrangler whoami` before you deploy, to make
sure you deploy to the correct Cloudflare account.

The model choices come from experiments recorded in `experiments/` (one 41 min video, hand-labeled):

| Stage | Model | Result in the experiment |
|---|---|---|
| Is an X post on screen? (every frame, 1 fps, 640 px) | `@cf/cloudflare/clef-flash` | 15/15 intervals, about $0.04 per 41 min |
| Read handle, display name, text (1280 px) | `@cf/google/gemma-4-26b-a4b-it` | 32/34 handles exact |
| Did the speaker read this post aloud? | `@cf/cloudflare/clef` | yes ≥ 0.32, no ≤ 0.26 |
| Where in the transcript? | `@cf/cloudflare/clairic` (`text` field span) | 11/11 within ~10 s |
| Text search over on-screen posts | D1 FTS5 + Vectorize (`@cf/baai/bge-m3`) | — |

## Components

```
Cron (every 10 min) ──> discover new videos (RSS) ──> D1 videos(status=pending)
                    └─> start VideoWorkflow for up to MAX_IN_FLIGHT pending videos
POST /admin/backfill ──> Container /list (yt-dlp) ──> D1 videos(status=pending)

VideoWorkflow(videoId)
  1 extract     Container job: yt-dlp + ffmpeg → R2 (frames 640 + 1280, words.json or audio chunks)
  2 transcript  only if no captions: Whisper on audio chunks → R2 words.json
  3 detect      clef-flash on kept 640 frames → inherited per-second probability
  4 runs        merge positive seconds into runs, pick 1 frame per 5 s + run end
  5 read        gemma-4 on the picked 1280 frames → posts per run (deduped)
  6 read-aloud  per post: clef on the transcript window; if yes, clairic span → timestamp + quote sentence
  7 store       D1 mentions + FTS rows, Vectorize vectors
  8 cleanup     delete non-image extraction data; expire temporary frames after three days

GET /  lookup page (server-rendered, query params ?handle=&tweet= or ?q=)
```

## Configuration (`src/config.ts`)

Sources and detectors are data. To add a creator, add an entry to `SOURCES` (today: `theo` and `prime`). To detect something other than X posts, add a
`Detector` and list its id in the source.

```ts
interface Source { id: string; name: string; avatar: string; youtubeChannelIds: string[]; detectors: string[] }  // one creator, many channels
interface Detector {
  id: string;                    // "x-post"
  label: string;                 // "X post"
  frameState: string;            // clef-flash `state`
  frameQuestion: string;         // clef-flash noul question
  frameThreshold: number;        // 0.5
  readerPrompt: string;          // gemma-4 prompt, one line per item: "@handle | display name | text"
  readAloudQuestion(post: Post): string;   // clef noul question
  readAloudThreshold: number;    // 0.3
  quoteInstructions(post: Post): string;   // clairic text-field instructions
}
```

Use the exact prompt strings from `experiments/scripts/run.ts` (STATE, TWEET_QUESTION), `experiments/scripts/ocr.ts`
(reader prompt) and `experiments/scripts/readaloud.ts` (read-aloud question and clairic instructions).

## Container HTTP API (`container/server.py`, port 8080)

Python stdlib only, plus the `yt-dlp` and `ffmpeg` binaries in the image. The Worker reaches it through
`getContainer(env.MEDIA, name).fetch("http://container/...")`.

- `GET /` → `{"ytdlp": "<version>"}`
- `POST /list` body `{"channelId", "limit": 80}` → `{"videos": [{"id","title","publishedAt","duration","liveStatus"}]}`.
  Uses `yt-dlp --flat-playlist -J --extractor-args youtubetab:approximate_date -I 1:<limit>` on both
  `https://www.youtube.com/channel/<id>/videos` and `/streams`. `publishedAt` is ISO 8601 from `timestamp`, or null.
  A tab that does not exist gives an empty list, not an error.
- `POST /jobs` body `{"videoId", "uploadBase", "token"}` → 202 with the job status. Starts a background thread.
  If a job for that video is running or done, return its status and do not start a second one.
- `GET /jobs/<videoId>` → `{"state": "running"|"done"|"error", "stage", "uploaded", "total", "error", "manifest"}`,
  or 404 if the container does not know the job (for example after a restart).

The job, in order:
1. `yt-dlp -J` metadata. If `live_status` is `is_live`, `is_upcoming` or `post_live`, fail with error `not_ready`.
2. Captions: `--skip-download --write-auto-subs --sub-langs en --sub-format vtt`. Parse the VTT into word timings
   (port `experiments/scripts/vtt.py`) and upload `videos/<id>/words.json` = `[[seconds, "word"], ...]`
   (seconds rounded to 2 decimals).
   If there are no English captions: download `bestaudio`, convert with ffmpeg to 16 kHz mono mp3 in 600 s segments,
   upload `videos/<id>/audio/000.mp3`, `001.mp3`, ...
3. Video: `-f "bv*[height<=720][vcodec^=avc1]/bv*[height<=720]/b[height<=720]"`. One ffmpeg pass with
   `fps=1,mpdecimate=hi=768:lo=320:frac=0.1,split=2` writes 640 px wide (`-q:v 5`) and 1280 px wide (`-q:v 4`) JPEGs. Use `-fps_mode vfr -enc_time_base 1:1 -frame_pts 1` on both outputs so filenames are real seconds.
   Upload as `videos/<id>/f640/<second>.jpg` and `videos/<id>/f1280/<second>.jpg` (second without zero padding).
   Delete the video file after ffmpeg finishes.
4. Upload `videos/<id>/manifest.json` =
   `{"videoId","title","duration","publishedAt","frames","keptSeconds","hasCaptions","audioChunks"}` last. `frames` is the count of all 1 fps samples before decimation, including a skipped tail.
   `keptSeconds` lists the stored seconds in order, starting at zero. Old manifests omit it and keep every second.

Upload = `PUT {uploadBase}/internal/r2/<key>` with `authorization: Bearer <token>` and a content type.
The Worker sets `uploadBase` to `http://r2.internal`. `MediaContainer.outboundByHost` intercepts that host and
writes to R2, so uploads do not go through the public Worker URL.
Use a pool of 16 threads and retry each upload 3 times. `stage` is one of `metadata`, `captions`, `audio`,
`download`, `frames`, `upload`, `done`. Delete the job's temp dir when it ends.

## Worker

Bindings (`wrangler.jsonc`):
- `MEDIA`: Container DO `MediaContainer`, `max_instances: 4`. Use an instance type with at least 10 GB of disk
  (check the current Containers instance types). `sleepAfter = "10m"`.
- `BUCKET`: R2 bucket `didtheomentionme-media`.
- `DB`: D1 database `didtheomentionme`, migrations in `migrations/`.
- `POSTS`: Vectorize index `didtheomentionme-posts`, 1024 dimensions, cosine.
- `AI`: Workers AI.
- `VIDEO_WORKFLOW`: Workflow `video-workflow`, class `VideoWorkflow`.
- Cron `*/10 * * * *`. Secret `INTERNAL_TOKEN`; without it every admin route returns 401. Export `ContainerProxy` for outbound interception.
- Secret `SENTRY_DSN` (org `sergtech`, project `didtheomentionme`); without it Sentry is off. `src/telemetry.ts`:
  - The fetch and cron handlers use `withSentry`; `VideoWorkflow` uses `instrumentWorkflowWithSentry`, so each
    `step.do` is a span and the trace id comes from the instance id. D1 and R2 calls get spans from the SDK.
  - Each model call is one `gen_ai.*` span from `modelSpan`: the model, `app.task` (for example "quote finder"), the
    inputs and outputs (images, audio and vectors become a size note), the tokens, the audio minutes and the cost in
    USD from the prices in `MODELS`. Update those prices when Workers AI pricing changes.
  - The SDK also wraps `env.AI` by itself. Its spans have no cost, so `ignoreSpans` drops them by their full `@cf/…`
    name; `modelSpan` names spans without that prefix.
  - Lookups have the spans `lookup`, `fetch post`, `search by meaning` (with `vectorize.query`) and `search by words`.
    The cron has `discover <source>` and `start pending videos`.

Routes:
- `POST /admin/reset?v=<id>`: bearer `INTERNAL_TOKEN`; destroys the video's container. A running container
  survives deploys and keeps its in-memory job, so use this before a manual retry.
- `POST /admin/backfill?source=theo&days=30`: bearer `INTERNAL_TOKEN`; Container `/list`, insert videos newer
  than `days` as `pending`, for each channel of the source. Skip videos shorter than 120 s (Shorts).
- `POST /admin/process?v=<id>&source=theo`: bearer `INTERNAL_TOKEN`; insert as pending and start the workflow now.
- `GET /frame/<videoId>/<second>.jpg`: an f1280 frame from R2, cached. Add `?size=640` for the exact detection frame. The route accepts only a video ID and numeric second, never an arbitrary R2 key.
- `GET /`: the lookup page. `GET /api/lookup`: the same data as JSON.

Cron: for each channel of each source, read the YouTube RSS feed (a failing channel is logged and skipped), insert unknown videos as `pending`, then start workflows for
pending videos (newest first) while fewer than `MAX_IN_FLIGHT = 3` are `processing`. Workflow instance id = video id (prefix `v` if it starts with `-`), then `_1`, `_2`, ... for each new attempt.
A video whose workflow cannot start gets status `error`; the other videos still start.
If an instance with that id exists, skip it.
Before it counts slots, the cron sets `error` ("workflow ended without a final status") on each `processing` video
whose latest workflow instance is missing or finished, so a failed workflow cannot hold a slot.

### VideoWorkflow details

- Set `videos.status` to `processing` at the start, `done` at the end, `error` (with message) on final failure.
  `not_ready` and the YouTube "confirm you're not a bot" download error set the status back to `pending`, so the
  next cron tick tries again.
- extract: a step POSTs `/jobs`, then loop: `step.sleep("30 seconds")` and a step that GETs `/jobs/<id>`
  (if 404, POST `/jobs` again). Stop at `done` or `error`, then destroy the container so the slot is free at once. Give up after 90 minutes.
- detect: one step per 120 kept frames. Fetch frames from R2, call clef-flash with concurrency 12, retry 429/5xx with
  backoff. Return probabilities rounded to 3 decimals. Expand them to all video seconds by inheriting the previous kept value. Missing stored frames fail the step.
- runs: seconds with p ≥ `frameThreshold`; join runs with gaps ≤ 3 s. Picks = every 5 s from the run start, plus the
  run end. Resolve each pick to its previous kept frame while preserving the requested second for observations.
- read: one step per run; gemma-4 with `chat_template_kwargs: { enable_thinking: false }`, `max_tokens: 1500`.
  Parse lines `@handle | display name | text`. Keep a line only if the handle matches `^@[A-Za-z0-9_]{1,15}$` and
  the text has at least 3 characters. Within a run, make one group per handle: lowercase handles match if equal,
  if the shorter one has ≥ 8 characters and is a prefix of the other, or if the shorter one has ≥ 6 characters and
  edit distance ≤ 2 (reader misreads). In each group keep each distinct text slice (token Jaccard < 0.6 to the
  others; a similar longer slice replaces a shorter one), the most common handle spelling, the first and last second
  seen, and the 1280 frame second where it was first seen.
- read-aloud: transcript window = words from run start - 30 s to run end + 30 s, joined with spaces, keeping the
  character offset of each word. clef `noul` with `readAloudQuestion` on each of the 3 longest
  slices; keep the highest p and its slice (a screenshot in a post can be longer than the post). If p ≥ `readAloudThreshold`, clairic
  `text` field with `quoteInstructions`; map `span[0]` to the word time (last word whose offset ≤ span start);
  the quote is the sentence of the window text that contains the span (expand to `.`, `?`, `!` or 120 chars).
- store: in one batch, copy the old vector ids of the video to `stale_vectors`, delete its mentions, insert the new
  mentions and FTS rows (re-runs are idempotent). Then delete the `stale_vectors` ids from Vectorize and their rows.
  A retry after a partial failure still finds the old ids. Embed `@handle: text` with bge-m3 and upsert to Vectorize with id `<videoId>:<mentionId>` and metadata
  `{ videoId, mentionId, handle }`.
- cleanup: delete non-image extraction objects. A daily sweep at 00:00 UTC deletes temporary f640 and f1280 images at least three days old, except f1280 images referenced by mentions. Bulk deletes use at most 1000 keys. See `docs/frame-sampling.md`.

### D1 schema (`migrations/0001_init.sql`, `0002_stale_vectors.sql`)

```sql
CREATE TABLE videos (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, published_at TEXT, duration INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE mentions (
  id INTEGER PRIMARY KEY, video_id TEXT NOT NULL, detector TEXT NOT NULL,
  handle TEXT NOT NULL, handle_norm TEXT NOT NULL, display_name TEXT, text TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, frame_second INTEGER NOT NULL,
  read_aloud_p REAL, read_aloud_at INTEGER, quote TEXT
);
CREATE INDEX mentions_handle ON mentions(handle_norm);
CREATE INDEX mentions_video ON mentions(video_id);
CREATE VIRTUAL TABLE mentions_fts USING fts5(text, content='mentions', content_rowid='id');
CREATE TABLE stale_vectors (vector_id TEXT PRIMARY KEY, video_id TEXT NOT NULL);
```

### Lookup

Input: `handle` (with or without `@`, or a profile or post URL), optional `tweet` (an x.com or twitter.com status URL), or `q` (words from
the post). A `q` search ignores `handle` and `tweet`.
- With a tweet URL, fetch the post from `https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<t>` where
  `t = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "")`. Take author handle, text, created_at.
  If the fetch fails, continue with the handle only and say so on the page. The handle is then the `handle` input,
  or the author in the post URL. A post URL in `handle` counts as `tweet`.
- Matches = mentions with `handle_norm` = the handle, plus (with a tweet) mentions whose text matches the post:
  Vectorize top 10 with score ≥ 0.8 whose metadata `videoId` is the D1 row's video (SQLite can reuse a deleted
  mention id), and FTS5 on the first 12 words of the post text. A match is `exact` when the
  handle matches and the text matches. Exact first, then newest video first.
- Text search (`q`): needs at least 2 words. Matches are the same Vectorize and FTS5 text matches, with any handle.
  Order: share of the query words in the text, then newest video first. `handle` is null and `query` is set.
- One post shown more than once in a video is one match with `times` (each first-seen second): same video, same
  handle (fuzzy), and the shorter text has ≥ 80% of its words in the longer. Text-search matches carry `overlap`.
- Response: `{ source: {id,name}, handle, query?, coverage: {videos, from, to}, tweet?, tweetError?, matches: [{
  videoId, title, publishedAt, handle, displayName, text, firstSeen, lastSeen, times, frameUrl, exact,
  readAloud: {at, quote} | null, overlap? }] }`.

Page: one column, system font, dark first with light mode. Heading "Did Theo mention me?" where the name is a sticker chip (`<details>`) that opens a menu of creators. The chip is
the creator's YouTube picture and name on a `--fg` background, tilted -2deg; it straightens on hover and when open, and the
name sets its baseline. A long name can make the chip wrap at 375px, so keep creator names short. The other options were
the plain pill (reads as generic chrome) and a dotted-underline name (people miss that it opens a menu). Each row is a
link to the same query with its `source` and shows that creator's coverage (or "First videos in progress"); each form
also sends `source`. The chip keeps the width of the longest name, so the heading does not move between creators.
There is no coverage line above the heading. The page falls back to the default creator for an
unknown `source`; `/api/lookup` returns 400. Three
tabs, each its own GET form: "Handle" (`handle`), "Post link" (`tweet`), "Text" (`q`). The tabs are radio inputs, so
they work without script; the page opens on the tab that matches the query. All three tabs use one field box: each
input joins its form through the `form` attribute, the inputs and hints share one grid cell, and each form has its own
Check button, shown only on its tab. A tab change crossfades only the input text and the hint (opacity and a 2px blur, no
blur with reduced motion); the box and the button do not move. Each creator has an accent hue (`Source.hue`: Theo 350,
Prime 55). The page sets it on `<html>`, and the neutrals use the hue minus 50, so the whole page takes the creator's color. A creator change from the menu crossfades the old page into
the new one (a cross-document view transition, 180ms, none with reduced motion). Other navigations skip it, so a search
answer never shows late. The answer rises in first and the match cards follow it. The answer is the first thing under the
form: "Yes." with a count, or "Not yet." with the coverage and a button to another tab. A text search shows matches
with ≥ 75% of the words as close matches; the rest go in a collapsed "N posts with some of these words" list (open
when there is no close match, with the answer "Not exactly."). Only the first 10 close matches show; the rest are
behind "Show N more". On a results page the heading is smaller and the intro is hidden. Lookup errors replace the
hint under the active tab's field. Each match is a card: the kept frame with an "On screen"
time links (one per time, plus "Read aloud" to the read-aloud second) to
`https://www.youtube.com/watch?v=<id>&t=<seconds>s`, video title and date, the post as read from
screen (query words marked in a text search), and, if read aloud, the time link and the quote.

## Not in v1

Alerts, transcript-only mentions (the creator names a post that is never on screen), clairic for post dates
(it misreads short dates such as "Sep 23"; see `experiments/scripts/meta.ts`).

## Result sharing and social images

Result URLs keep the existing GET parameters (`handle`, `tweet`, `q`, and `source`). `src/share.ts` builds the same URL for creator navigation, canonical metadata, copy/share, and X intents. The production origin is explicit, so previews cannot make social crawlers follow a local development address. Video links open a new tab and reference one screen reader hint. Copy confirms for 1.5 seconds; Web Share cancellation does not trigger a copy.

`src/social.ts` serves `/og.png`, `/favicon.svg`, and `/apple-touch-icon.png`. OG PNGs are 1200×630. They use the same lookup as the page, the first close match's retained R2 frame, a creator avatar, and the total number of on-screen appearances. Text results exclude loose matches from the headline. Missing frames fall back to the branded illustration; an avatar timeout does not block rendering.

The renderer is hand-built SVG plus `@resvg/resvg-wasm`, initialized once per isolate. This keeps the card layout explicit and avoids Satori/Yoga and Browser Rendering service calls. The WASM is about 2.4 MB raw / 1 MB gzip. `src/assets/inter.bin` is a 39 KB static Inter Bold TTF, instantiated at weight 700 / optical size 32 and subset to Latin characters plus the card punctuation. Its OFL license is beside it. The font is bundled as a Data module, with no render-time font download. The page continues to use system fonts.

Cache API stores complete PNG responses under normalized query keys in `social-v3`. Result cards use `public, max-age=3600`; default and Apple images use 86400 seconds. SVG icons use 604800 seconds. Cache hits skip D1, R2, avatar fetch, and rasterization. Bump the cache namespace/key version when changing a card. Cache API is local to a Cloudflare data center; it is not durable global R2 storage. Unique uncached searches still incur lookup and rasterization work. Production CPU and total compressed Worker bundle size require a parent deployment check; no deployment was run for this change.

Verification used Wrangler through portless, containers disabled, with remote D1/R2. PNG samples are in `/tmp/dtmm-shots/`: `og-default.png`, `og-theo.png`, and `og-prime.png`. The Theo sample searches `theo`; the Prime sample searches `ThePrimeagen`. The favicon is a play button inside a speech bubble with a small check badge, rendered at 16/32/180 px in `favicon-sizes.png`.

### Frame telemetry

The SDK creates each AI span. A `spanStart` hook adds `app.frame.key`, `app.frame.second`,
`app.frame.url`, and `app.frame.youtube_url` from a call-local Sentry scope. Concurrent calls keep separate scopes.
Gemma image data URLs become the frame URL in `gen_ai.input.messages`. In SDK 11.10.0, clef-flash records
only evaluation state and questions; its images never enter that attribute. No extra span is created.
