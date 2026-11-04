const RETENTION_MS = 3 * 86400 * 1000;

export const isExpiredFrame = (key: string, uploaded: Date, now: number, permanent = new Set<string>()) =>
  /^videos\/[^/]+\/f(?:640|1280)\/\d+\.jpg$/.test(key) && !permanent.has(key) && uploaded.getTime() <= now - RETENTION_MS;

/** Existing frame keys cannot use one R2 lifecycle prefix without expiring permanent images. */
export async function expireFrames(bucket: R2Bucket, db: D1Database, now: number): Promise<void> {
  const { results } = await db.prepare("SELECT video_id, frame_second FROM mentions").all<{ video_id: string; frame_second: number }>();
  const permanent = new Set(results.map((row) => `videos/${row.video_id}/f1280/${row.frame_second}.jpg`));
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "videos/", cursor, limit: 1000 });
    const keys = page.objects.filter((object) => isExpiredFrame(object.key, object.uploaded, now, permanent)).map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
