-- Keep scan coverage separate from message cursors: seeing a webhook or one
-- page does not prove that the rest of a channel has been reconciled.
CREATE TABLE IF NOT EXISTS channel_sync_state (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  history_through INTEGER NOT NULL,
  full_scan_through INTEGER,
  PRIMARY KEY (team_id, channel_id)
);

CREATE TABLE IF NOT EXISTS slack_directory_sync (
  team_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL
);
