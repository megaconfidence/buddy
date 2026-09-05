PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS slack_events (
  event_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_events_received_at
  ON slack_events(received_at);

CREATE TABLE IF NOT EXISTS slack_messages (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  event_id TEXT,
  user_id TEXT,
  text TEXT NOT NULL DEFAULT '',
  subtype TEXT,
  posted_at INTEGER NOT NULL,
  event_time INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id, message_ts)
);

CREATE INDEX IF NOT EXISTS idx_slack_messages_window
  ON slack_messages(team_id, posted_at, deleted_at);

CREATE INDEX IF NOT EXISTS idx_slack_messages_thread
  ON slack_messages(team_id, channel_id, thread_ts, posted_at);

CREATE INDEX IF NOT EXISTS idx_slack_messages_user
  ON slack_messages(team_id, user_id, posted_at);

CREATE TABLE IF NOT EXISTS slack_channels (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT,
  is_private INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id)
);

CREATE TABLE IF NOT EXISTS slack_users (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT,
  real_name TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_cursors (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  latest_ts TEXT NOT NULL,
  reconciled_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id)
);

CREATE TABLE IF NOT EXISTS digest_runs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  workflow_instance_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed')
  ),
  slack_channel_id TEXT,
  slack_message_ts TEXT,
  error TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, user_id, local_date)
);

CREATE INDEX IF NOT EXISTS idx_digest_runs_status
  ON digest_runs(status, local_date);

CREATE TABLE IF NOT EXISTS daily_digests (
  digest_id TEXT PRIMARY KEY,
  markdown TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_message_count INTEGER NOT NULL,
  selected_item_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (digest_id) REFERENCES digest_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  digest_id TEXT,
  item_id TEXT,
  value TEXT NOT NULL CHECK (
    value IN ('relevant', 'not_relevant', 'handled')
  ),
  note TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (digest_id) REFERENCES digest_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_events_user
  ON feedback_events(team_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS profile_versions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, user_id, version)
);
