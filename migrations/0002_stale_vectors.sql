CREATE TABLE stale_vectors (vector_id TEXT PRIMARY KEY, video_id TEXT NOT NULL);
CREATE INDEX stale_vectors_video ON stale_vectors(video_id);
