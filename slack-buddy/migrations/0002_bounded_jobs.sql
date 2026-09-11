CREATE TABLE IF NOT EXISTS slack_jobs (
  id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL,
  team_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('digest', 'directory')),
  params_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (run_key, sequence)
);
CREATE INDEX IF NOT EXISTS idx_slack_jobs_pending ON slack_jobs(team_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_slack_jobs_run ON slack_jobs(run_key, sequence);

CREATE TABLE IF NOT EXISTS slack_job_artifacts (
  run_key TEXT NOT NULL,
  name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_key, name)
);
