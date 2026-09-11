-- The MCP app stores preferences and operational metadata, never search results.
CREATE TABLE IF NOT EXISTS mcp_profiles (
  owner_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0,
  partial INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'none',
  message_ts TEXT,
  channel_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_runs_owner ON mcp_runs(owner_id, started_at);
CREATE TABLE IF NOT EXISTS mcp_locks (
  owner_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_login_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
