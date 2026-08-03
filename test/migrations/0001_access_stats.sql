CREATE TABLE IF NOT EXISTS access_stats (
  name TEXT NOT NULL,
  digest TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_access INTEGER NOT NULL,
  PRIMARY KEY (name, digest)
);

CREATE INDEX IF NOT EXISTS idx_access_stats_name ON access_stats (name, last_access);
