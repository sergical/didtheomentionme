# Frame sampling and debugging

The container stores one frame for every second of video.

We tested FFmpeg `mpdecimate` to skip frames that do not change. On `Ka0p5tUUmgg` (687 seconds) it kept
all 687 frames at every threshold we tried. On an older JPEG sequence it kept 2468 of 2470 frames (0.081%).
A moving presenter changes enough of each frame to stop the skip. We removed the filter because it saved nothing.
A real saving needs a tested screen-region or text-change detector. Do not mask a fixed webcam area
without testing both creators and their layouts.
Reference: https://ffmpeg.org/ffmpeg-filters.html#mpdecimate

## Sparse workflow

The worker still accepts a sparse frame list, so a future detector can skip seconds.
`frames` counts all one-second samples. `keptSeconds` contains the stored seconds.
Missing `keptSeconds` means the legacy dense layout. Each skipped second inherits the probability
of its previous kept frame, including the last seconds of the video. Runs and read picks use real video seconds.
Read picks resolve to the previous stored f1280 image; observations retain the requested second,
while mention `frameSecond` identifies the actual stored image.
Both image sizes upload only kept seconds. Missing expected frames fail rather than silently creating negative detections.

Further f1280 upload savings require a second container phase after detection: keep the download or extracted images
in the container, request only the read picks, then release it. The current workflow releases the container before detection.
This needs a separate design for container restarts and workflow retries.

## Span references

The existing gen_ai span gets these attributes, with no extra span:

```json
{
  "app.frame.key": "videos/Ka0p5tUUmgg/f640/390.jpg",
  "app.frame.second": 390,
  "app.frame.url": "https://didtheomentionme.s-a62.workers.dev/frame/Ka0p5tUUmgg/390.jpg?size=640",
  "app.frame.youtube_url": "https://www.youtube.com/watch?v=Ka0p5tUUmgg&t=390s"
}
```

Gemma records its image URL in the message attribute instead of base64. SDK 11.10.0 omits clef-flash images
entirely and records evaluation state and questions. The local test runs the installed AI instrumentation
and verifies two concurrent calls have distinct frame references and no image bytes.
The origin is the current production Worker URL in `src/telemetry.ts`; change it if the app moves.

## Retention and cost

No bucket setting or deployment was changed. Code keeps f640 and f1280 images after workflow cleanup.
The existing ten-minute cron runs a sweep at 00:00 UTC. It removes images at least three days old,
so retention is three to four days when the cron succeeds. Mention f1280 images stay permanent.
A failed cron delays expiry. Old temporary images already deleted cannot be recovered.

R2 lifecycle rules filter by prefix. The existing `videos/<id>/f640/` layout cannot use one shared rule
without also deleting permanent images. The sweep preserves existing keys and avoids per-video bucket rules.
A future `debug/` prefix could use a bucket lifecycle rule instead.
Reference: https://developers.cloudflare.com/r2/buckets/object-lifecycles/

The measured JPEG averages are 21,297 bytes at 640 px and 57,974 bytes at 1280 px.
At 152,000 retained seconds this is about 12.05 GB before expiry. At $0.015/GB-month,
a one-time batch held three to four days costs roughly $0.018–$0.024 before free allowances and billing rounding.
At that same volume per month, average temporary storage is about 1.2–1.6 GB.
A full 304,000-object sweep needs about 304 LIST requests, or $0.00137 at $4.50/million.
Deletes are free. A steady three-to-four-day window is smaller. These are estimates, not an account bill.
Reference: https://developers.cloudflare.com/r2/pricing/

The public frame route exposes only JPEG frames of public videos. It accepts no tokens or arbitrary object paths.
A deleted frame returns 404; cached images can remain available for the existing seven-day cache lifetime.
