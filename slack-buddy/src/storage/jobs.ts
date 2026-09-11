import { slackJobId, type SlackJobParams } from "../domain/jobs";

export type SlackJob = { id: string; params: SlackJobParams; status: string };
type JobRow = { id: string; params_json: string; status: string };

export class SlackJobRepository {
  constructor(private readonly db: D1Database) {}

  private insert(id: string, params: SlackJobParams) {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO slack_jobs
      (id, run_key, team_id, sequence, kind, params_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        id,
        params.runKey,
        params.teamId,
        params.sequence,
        params.digest ? "digest" : "directory",
        JSON.stringify(params),
        Date.now(),
        Date.now(),
      );
  }

  async enqueue(params: SlackJobParams): Promise<SlackJob> {
    const id = await slackJobId(params.runKey, params.sequence);
    await this.insert(id, params).run();
    return this.get(id);
  }

  async get(id: string): Promise<SlackJob> {
    const row = await this.db
      .prepare("SELECT id, params_json, status FROM slack_jobs WHERE id = ?")
      .bind(id)
      .first<JobRow>();
    if (!row) throw new Error(`Missing Slack job ${id}`);
    return {
      id: row.id,
      params: JSON.parse(row.params_json) as SlackJobParams,
      status: row.status,
    };
  }

  async listIncomplete(teamId: string): Promise<SlackJob[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, params_json, status FROM slack_jobs
      WHERE team_id = ? AND status != 'completed' ORDER BY updated_at ASC LIMIT 25`,
      )
      .bind(teamId)
      .all<JobRow>();
    return rows.results.map((row) => ({
      id: row.id,
      params: JSON.parse(row.params_json) as SlackJobParams,
      status: row.status,
    }));
  }

  async deleteExpiredCompletedRuns(beforeMs: number): Promise<void> {
    // Retain entire active chains; deleting only their completed roots would
    // make the scheduler enqueue the digest again.
    const expired = `SELECT run_key FROM slack_jobs GROUP BY run_key
      HAVING MAX(updated_at) < ? AND SUM(status != 'completed') = 0
        AND run_key NOT IN (SELECT run_key FROM slack_directory_sync)
        AND run_key NOT IN (
          SELECT json_extract(a.value_json, '$.runKey') FROM slack_job_artifacts a
          WHERE a.name = 'cached-directory' AND EXISTS (
            SELECT 1 FROM slack_jobs active WHERE active.run_key = a.run_key AND active.status != 'completed'
          )
        )`;
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM slack_job_artifacts WHERE run_key IN (${expired})`,
        )
        .bind(beforeMs),
      this.db
        .prepare(`DELETE FROM slack_jobs WHERE run_key IN (${expired})`)
        .bind(beforeMs),
    ]);
  }

  async freshDirectory(
    teamId: string,
    afterMs: number,
  ): Promise<{ runKey: string } | null> {
    return this.db
      .prepare(
        "SELECT run_key AS runKey FROM slack_directory_sync WHERE team_id = ? AND refreshed_at >= ?",
      )
      .bind(teamId, afterMs)
      .first<{ runKey: string }>();
  }

  async recordDirectory(teamId: string, runKey: string): Promise<void> {
    // Freeze the snapshot atomically with publication. A restarted Workflow
    // must neither mutate it nor renew its freshness or republish it later.
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO slack_directory_sync (team_id,run_key,refreshed_at)
        SELECT ?,?,? WHERE NOT EXISTS (
          SELECT 1 FROM slack_job_artifacts WHERE run_key = ? AND name = 'directory-complete'
        )
        ON CONFLICT(team_id) DO UPDATE SET run_key=excluded.run_key,refreshed_at=excluded.refreshed_at`,
        )
        .bind(teamId, runKey, Date.now(), runKey),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO slack_job_artifacts (run_key,name,value_json,created_at)
        VALUES (?,'directory-complete','true',?)`,
        )
        .bind(runKey, Date.now()),
    ]);
  }

  async enqueueDirectory(params: SlackJobParams): Promise<void> {
    const id = await slackJobId(params.runKey, params.sequence);
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO slack_jobs
      (id, run_key, team_id, sequence, kind, params_json, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, 'directory', ?, 'pending', ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM slack_jobs WHERE team_id = ? AND kind = 'directory' AND status != 'completed')`,
      )
      .bind(
        id,
        params.runKey,
        params.teamId,
        params.sequence,
        JSON.stringify(params),
        Date.now(),
        Date.now(),
        params.teamId,
      )
      .run();
  }

  async touch(id: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE slack_jobs SET updated_at = ? WHERE id = ? AND status != 'completed'",
      )
      .bind(Date.now(), id)
      .run();
  }

  async markRunning(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slack_jobs SET status = 'running', error = NULL, updated_at = ?
      WHERE id = ? AND status != 'completed'`,
      )
      .bind(Date.now(), id)
      .run();
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slack_jobs SET status = 'failed', error = ?, updated_at = ?
      WHERE id = ? AND status != 'completed'`,
      )
      .bind(error.slice(0, 2_000), Date.now(), id)
      .run();
  }

  /** Persist the successor and completion together before attempting Workflow creation. */
  async finish(
    id: string,
    next: SlackJobParams | null,
  ): Promise<SlackJob | null> {
    const nextId = next ? await slackJobId(next.runKey, next.sequence) : null;
    await this.db.batch([
      ...(next && nextId ? [this.insert(nextId, next)] : []),
      this.db
        .prepare(
          `UPDATE slack_jobs SET status = 'completed', error = NULL, updated_at = ? WHERE id = ?`,
        )
        .bind(Date.now(), id),
    ]);
    return nextId ? this.get(nextId) : null;
  }

  async put(runKey: string, name: string, value: unknown): Promise<void> {
    await this.putMany(runKey, [{ name, value }]);
  }

  async putMany(
    runKey: string,
    values: Array<{ name: string; value: unknown }>,
  ): Promise<void> {
    for (let offset = 0; offset < values.length; offset += 50) {
      await this.db.batch(
        values.slice(offset, offset + 50).map(({ name, value }) =>
          this.db
            .prepare(
              `INSERT INTO slack_job_artifacts (run_key, name, value_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_key, name) DO UPDATE SET value_json = excluded.value_json`,
            )
            .bind(runKey, name, JSON.stringify(value), Date.now()),
        ),
      );
    }
  }

  async find<T = unknown>(runKey: string, name: string): Promise<T | null> {
    const row = await this.db
      .prepare(
        "SELECT value_json FROM slack_job_artifacts WHERE run_key = ? AND name = ?",
      )
      .bind(runKey, name)
      .first<{ value_json: string }>();
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  async read<T>(runKey: string, name: string): Promise<T> {
    const value = await this.find<T>(runKey, name);
    if (value === null) throw new Error(`Missing Slack job artifact ${name}`);
    return value;
  }

  async next<T>(
    runKey: string,
    prefix: string,
    after = prefix,
  ): Promise<{ name: string; value: T } | null> {
    const row = await this.db
      .prepare(
        `SELECT name, value_json FROM slack_job_artifacts
      WHERE run_key = ? AND name > ? AND name >= ? AND name < ? ORDER BY name LIMIT 1`,
      )
      .bind(runKey, after, prefix, `${prefix}\uffff`)
      .first<{ name: string; value_json: string }>();
    return row
      ? { name: row.name, value: JSON.parse(row.value_json) as T }
      : null;
  }

  async all<T>(runKey: string, prefix: string): Promise<T[]> {
    const rows = await this.db
      .prepare(
        `SELECT value_json FROM slack_job_artifacts
      WHERE run_key = ? AND name >= ? AND name < ? ORDER BY name`,
      )
      .bind(runKey, prefix, `${prefix}\uffff`)
      .all<{ value_json: string }>();
    return rows.results.map((row) => JSON.parse(row.value_json) as T);
  }
}
