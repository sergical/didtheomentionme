const RETENTION_MS = 3 * 86400 * 1000;
/** A video keeps its f1280 frames until it is reprocessed from the 1080p source. */
const LARGE_FRAMES = ["f1920", "f1280"];

export async function largeFrame(bucket: R2Bucket, videoId: string, second: string): Promise<R2ObjectBody | null> {
  for (const size of LARGE_FRAMES) {
    const object = await bucket.get(`videos/${videoId}/${size}/${second}.jpg`);
    if (object) return object;
  }
  return null;
}

export const isExpiredFrame = (key: string, uploaded: Date, now: number, permanent = new Set<string>()) =>
  /^videos\/[^/]+\/f(?:640|1280|1920)\/\d+\.jpg$/.test(key) && !permanent.has(key) && uploaded.getTime() <= now - RETENTION_MS;

/** Existing frame keys cannot use one R2 lifecycle prefix without expiring permanent images. */
export async function expireFrames(bucket: R2Bucket, db: D1Database, now: number): Promise<void> {
  const { results } = await db.prepare("SELECT video_id, frame_second FROM mentions").all<{ video_id: string; frame_second: number }>();
  const permanent = new Set(results.flatMap((row) => LARGE_FRAMES.map((size) => `videos/${row.video_id}/${size}/${row.frame_second}.jpg`)));
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "videos/", cursor, limit: 1000 });
    const keys = page.objects.filter((object) => isExpiredFrame(object.key, object.uploaded, now, permanent)).map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
