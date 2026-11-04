CREATE TABLE video_runs (
  instance_id TEXT PRIMARY KEY, video_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  outcome TEXT, reason TEXT
);
CREATE INDEX video_runs_video ON video_runs(video_id);
