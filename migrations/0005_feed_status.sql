-- When each YouTube feed last answered, so a short run of failures (YouTube rate limits Cloudflare's addresses)
-- is a log line, and only a feed that stays down becomes a Sentry Issue.
CREATE TABLE feed_status (
  channel_id TEXT PRIMARY KEY,
  last_ok_at TEXT,
  failing_since TEXT,
  last_error TEXT
);
