import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "./settings";

export class AppStore {
  constructor(
    private db: D1Database,
    private owner: string,
  ) {}
  async settings() {
    const row = await this.db
      .prepare(
        "SELECT settings_json,version FROM mcp_profiles WHERE owner_id=?",
      )
      .bind(this.owner)
      .first<{ settings_json: string; version: number }>();
    return row
      ? {
          settings: settingsSchema.parse(JSON.parse(row.settings_json)),
          version: row.version,
        }
      : { settings: structuredClone(DEFAULT_SETTINGS), version: 0 };
  }
  async save(settings: Settings, version: number) {
    const result =
      version === 0
        ? await this.db
            .prepare(
              "INSERT OR IGNORE INTO mcp_profiles(owner_id,settings_json,version,updated_at) VALUES(?,?,1,?)",
            )
            .bind(this.owner, JSON.stringify(settings), Date.now())
            .run()
        : await this.db
            .prepare(
              "UPDATE mcp_profiles SET settings_json=?,version=version+1,updated_at=? WHERE owner_id=? AND version=?",
            )
            .bind(JSON.stringify(settings), Date.now(), this.owner, version)
            .run();
    if (!result.meta.changes) throw new Error("settings_conflict");
    return { settings, version: version + 1 };
  }
  async begin(id: string, kind: string) {
    const now = Date.now();
    const lease = await this.db
      .prepare(
        `INSERT INTO mcp_locks(owner_id,run_id,expires_at) VALUES(?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET run_id=excluded.run_id,expires_at=excluded.expires_at WHERE mcp_locks.expires_at<?`,
      )
      .bind(this.owner, id, now + 240_000, now)
      .run();
    if (!lease.meta.changes) throw new Error("run_busy");
    try {
      const r = await this.db
        .prepare(
          "INSERT OR IGNORE INTO mcp_runs(id,owner_id,kind,status,started_at) VALUES(?,?,?,'running',?)",
        )
        .bind(id, this.owner, kind, now)
        .run();
      if (!r.meta.changes) throw new Error("run_exists");
    } catch (e) {
      await this.release(id);
      throw e;
    }
  }
  async finish(
    id: string,
    requests: number,
    results: number,
    partial: boolean,
    error?: string,
  ) {
    await this.db
      .prepare(
        "UPDATE mcp_runs SET status=?,finished_at=?,request_count=?,result_count=?,partial=?,error_code=? WHERE id=? AND owner_id=?",
      )
      .bind(
        error ? "failed" : "completed",
        Date.now(),
        requests,
        results,
        Number(partial),
        error ?? null,
        id,
        this.owner,
      )
      .run();
    await this.release(id);
  }
  private async release(id: string) {
    await this.db
      .prepare("DELETE FROM mcp_locks WHERE owner_id=? AND run_id=?")
      .bind(this.owner, id)
      .run();
  }
  async runs() {
    await this.expireRuns();
    const r = await this.db
      .prepare(
        "SELECT id,kind,status,started_at,finished_at,request_count,result_count,partial,error_code,delivery_status FROM mcp_runs WHERE owner_id=? ORDER BY started_at DESC LIMIT 20",
      )
      .bind(this.owner)
      .all();
    return r.results;
  }
  async deliveryIntent(id: string) {
    const r = await this.db
      .prepare(
        "UPDATE mcp_runs SET delivery_status='sending' WHERE id=? AND owner_id=? AND status='completed' AND delivery_status='none'",
      )
      .bind(id, this.owner)
      .run();
    return Boolean(r.meta.changes);
  }
  async delivered(
    id: string,
    channel: string | null,
    ts: string | null,
    status = "sent",
  ) {
    await this.db
      .prepare(
        "UPDATE mcp_runs SET delivery_status=?,channel_id=?,message_ts=? WHERE id=? AND owner_id=? AND delivery_status='sending'",
      )
      .bind(status, channel, ts, id, this.owner)
      .run();
  }
  async cleanup() {
    await this.expireRuns();
    await this.db.batch([
      this.db
        .prepare("DELETE FROM mcp_runs WHERE owner_id=? AND started_at<?")
        .bind(this.owner, Date.now() - 30 * 86400_000),
      this.db
        .prepare("DELETE FROM mcp_login_attempts WHERE reset_at<?")
        .bind(Date.now()),
    ]);
  }
  private async expireRuns() {
    await this.db
      .prepare(
        `UPDATE mcp_runs SET status='failed',finished_at=?,error_code='interrupted',partial=1
       WHERE owner_id=? AND status='running' AND started_at<?
       AND NOT EXISTS(SELECT 1 FROM mcp_locks WHERE mcp_locks.owner_id=mcp_runs.owner_id AND run_id=mcp_runs.id AND expires_at>?)`,
      )
      .bind(Date.now(), this.owner, Date.now() - 240_000, Date.now())
      .run();
  }
}
