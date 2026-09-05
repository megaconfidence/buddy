PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  poll_interval_minutes INTEGER NOT NULL,
  authority INTEGER NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_state (
  source_id TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  cursor TEXT,
  baselined INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  snapshot_key TEXT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sources_enabled
  ON sources(enabled, poll_interval_minutes);

CREATE INDEX IF NOT EXISTS idx_source_state_due
  ON source_state(last_checked_at, consecutive_failures);

CREATE TABLE IF NOT EXISTS source_items (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at INTEGER,
  updated_at INTEGER,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, external_id),
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_source_items_artifact
  ON source_items(artifact_key);

CREATE TABLE IF NOT EXISTS change_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (
    change_type IN ('created', 'updated', 'deprecated', 'retired', 'yanked')
  ),
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_key TEXT,
  published_at INTEGER,
  detected_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new' CHECK (
    status IN ('new', 'included', 'ignored')
  ),
  digest_id TEXT,
  UNIQUE (source_id, external_id, content_hash),
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_change_events_digest_window
  ON change_events(status, detected_at);

CREATE INDEX IF NOT EXISTS idx_change_events_artifact
  ON change_events(artifact_key, detected_at);

CREATE TABLE IF NOT EXISTS digest_runs (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed')
  ),
  model TEXT,
  subject TEXT,
  overview TEXT,
  structured_json TEXT,
  html TEXT,
  text TEXT,
  email_idempotency_key TEXT NOT NULL UNIQUE,
  provider_message_id TEXT,
  last_error TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_digest_runs_status
  ON digest_runs(status, local_date);

CREATE TABLE IF NOT EXISTS digest_items (
  digest_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  editorial_json TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL,
  PRIMARY KEY (digest_id, item_id),
  FOREIGN KEY (digest_id) REFERENCES digest_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (
    value IN ('pursue', 'not_relevant', 'handled')
  ),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (digest_id, item_id)
    REFERENCES digest_items(digest_id, item_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feedback_events_item
  ON feedback_events(digest_id, item_id, created_at);

CREATE TABLE IF NOT EXISTS preference_profile (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  profile_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
