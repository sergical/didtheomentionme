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
