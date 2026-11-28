import { Effect } from "effect";
import { r2, sql } from "./runtime";

const RETENTION_MS = 3 * 86400 * 1000;

/** A video keeps its f1280 frames until it is reprocessed from the 1080p source. */
const LARGE_FRAMES = ["f1920", "f1280"];

export const largeFrame = (videoId: string, second: string) =>
  Effect.gen(function* () {
    for (const size of LARGE_FRAMES) {
      const key = `videos/${videoId}/${size}/${second}.jpg`;
      const object = yield* r2("GetObject", key, (bucket) => bucket.get(key));

      if (object) return object;
    }

    return null;
  });

export const isExpiredFrame = (key: string, uploaded: Date, now: number, permanent = new Set<string>()) =>
  /^videos\/[^/]+\/f(?:640|1280|1920)\/\d+\.jpg$/.test(key) && !permanent.has(key) && uploaded.getTime() <= now - RETENTION_MS;

/** Existing frame keys cannot use one R2 lifecycle prefix without expiring permanent images. */
export const expireFrames = (now: number) =>
  Effect.gen(function* () {
    const results = yield* sql.all<{ video_id: string; frame_second: number }>("SELECT video_id, frame_second FROM mentions");
    const permanent = new Set(results.flatMap((row) => LARGE_FRAMES.map((size) => `videos/${row.video_id}/${size}/${row.frame_second}.jpg`)));
    let cursor: string | undefined;
    let deleted = 0;

    do {
      const page = yield* r2("ListObjects", "videos/", (bucket) => bucket.list({ prefix: "videos/", cursor, limit: 1000 }));
      const keys = page.objects.filter((object) => isExpiredFrame(object.key, object.uploaded, now, permanent)).map((object) => object.key);

      if (keys.length) yield* r2("DeleteObject", keys.join(", "), (bucket) => bucket.delete(keys));
      deleted += keys.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return deleted;
  });
