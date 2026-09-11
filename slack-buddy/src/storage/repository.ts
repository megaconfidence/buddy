import type {
  DigestWindow,
  RelevanceProfile,
  SlackMessage,
  StructuredDigest,
} from "../domain/types";
import type { MessageWithDisplay } from "../domain/threads";

export type DigestRunRow = {
  id: string;
  team_id: string;
  user_id: string;
  local_date: string;
  timezone: string;
  window_start: number;
  window_end: number;
  workflow_instance_id: string | null;
  status: "pending" | "running" | "completed" | "failed";
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  error: string | null;
};

type MessageRow = {
  team_id: string;
  channel_id: string;
  message_ts: string;
  thread_ts: string;
  event_id: string | null;
  user_id: string | null;
  text: string;
  subtype: string | null;
  posted_at: number;
  event_time: number;
  edited_at: number | null;
  deleted_at: number | null;
  channel_name: string | null;
  user_name: string | null;
  is_bot: number | null;
};

export class SlackBuddyRepository {
  constructor(private readonly db: D1Database) {}

  async ingestMessage(message: SlackMessage): Promise<void> {
    await this.ingestMessages([message]);
  }

  async ingestMessages(messages: SlackMessage[]): Promise<void> {
    for (const chunk of chunks(messages, 50)) {
      await this.db.batch(
        chunk.flatMap((message) => this.messageStatements(message)),
      );
    }
  }

  async deleteMessage(input: {
    eventId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    eventTime: number;
  }): Promise<void> {
    const now = Date.now();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO slack_events (
            event_id, team_id, event_type, received_at
          ) VALUES (?, ?, 'message_deleted', ?)`,
        )
        .bind(input.eventId, input.teamId, now),
      this.db
        .prepare(
          `INSERT INTO slack_messages (
            team_id, channel_id, message_ts, thread_ts, event_id, user_id,
            text, subtype, posted_at, event_time, edited_at, deleted_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, '', 'message_deleted', ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(team_id, channel_id, message_ts) DO UPDATE SET
            event_id = excluded.event_id,
            event_time = MAX(excluded.event_time, slack_messages.event_time),
            deleted_at = COALESCE(
              slack_messages.deleted_at,
              excluded.deleted_at
            ),
            updated_at = excluded.updated_at`,
        )
        .bind(
          input.teamId,
          input.channelId,
          input.messageTs,
          input.messageTs,
          input.eventId,
          slackTimestampMs(input.messageTs),
          input.eventTime,
          now,
          now,
          now,
        ),
    ]);
  }

  async upsertChannel(input: {
    teamId: string;
    channelId: string;
    name: string | null;
    isPrivate: boolean;
    isArchived: boolean;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO slack_channels (
          team_id, channel_id, name, is_private, is_archived, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(team_id, channel_id) DO UPDATE SET
          name = COALESCE(excluded.name, slack_channels.name),
          is_private = excluded.is_private,
          is_archived = excluded.is_archived,
          updated_at = excluded.updated_at
          WHERE COALESCE(excluded.name, slack_channels.name) IS NOT slack_channels.name
            OR excluded.is_private IS NOT slack_channels.is_private
            OR excluded.is_archived IS NOT slack_channels.is_archived`,
      )
      .bind(
        input.teamId,
        input.channelId,
        input.name,
        Number(input.isPrivate),
        Number(input.isArchived),
        Date.now(),
      )
      .run();
  }

  async touchChannel(input: {
    teamId: string;
    channelId: string;
    name: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO slack_channels (
          team_id, channel_id, name, is_private, is_archived, updated_at
        ) VALUES (?, ?, ?, 0, 0, ?)
        ON CONFLICT(team_id, channel_id) DO UPDATE SET
          name = COALESCE(excluded.name, slack_channels.name),
          updated_at = excluded.updated_at
          WHERE COALESCE(excluded.name, slack_channels.name) IS NOT slack_channels.name`,
      )
      .bind(input.teamId, input.channelId, input.name, Date.now())
      .run();
  }

  async upsertChannels(
    inputs: Array<{
      teamId: string;
      channelId: string;
      name: string | null;
      isPrivate: boolean;
      isArchived: boolean;
    }>,
  ): Promise<void> {
    for (const chunk of chunks(inputs, 100)) {
      await this.db.batch(
        chunk.map((input) =>
          this.db
            .prepare(
              `INSERT INTO slack_channels (
                team_id, channel_id, name, is_private, is_archived, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(team_id, channel_id) DO UPDATE SET
                name = COALESCE(excluded.name, slack_channels.name),
                is_private = excluded.is_private,
                is_archived = excluded.is_archived,
                updated_at = excluded.updated_at
          WHERE COALESCE(excluded.name, slack_channels.name) IS NOT slack_channels.name
            OR excluded.is_private IS NOT slack_channels.is_private
            OR excluded.is_archived IS NOT slack_channels.is_archived`,
            )
            .bind(
              input.teamId,
              input.channelId,
              input.name,
              Number(input.isPrivate),
              Number(input.isArchived),
              Date.now(),
            ),
        ),
      );
    }
  }

  async upsertUser(input: {
    teamId: string;
    userId: string;
    displayName: string | null;
    realName: string | null;
    isBot: boolean;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO slack_users (
          team_id, user_id, display_name, real_name, is_bot, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(team_id, user_id) DO UPDATE SET
          display_name = COALESCE(excluded.display_name, slack_users.display_name),
          real_name = COALESCE(excluded.real_name, slack_users.real_name),
          is_bot = excluded.is_bot,
          updated_at = excluded.updated_at
          WHERE COALESCE(excluded.display_name, slack_users.display_name) IS NOT slack_users.display_name
            OR COALESCE(excluded.real_name, slack_users.real_name) IS NOT slack_users.real_name
            OR excluded.is_bot IS NOT slack_users.is_bot`,
      )
      .bind(
        input.teamId,
        input.userId,
        input.displayName,
        input.realName,
        Number(input.isBot),
        Date.now(),
      )
      .run();
  }

  async upsertUsers(
    inputs: Array<{
      teamId: string;
      userId: string;
      displayName: string | null;
      realName: string | null;
      isBot: boolean;
    }>,
  ): Promise<void> {
    for (const chunk of chunks(inputs, 100)) {
      await this.db.batch(
        chunk.map((input) =>
          this.db
            .prepare(
              `INSERT INTO slack_users (
                team_id, user_id, display_name, real_name, is_bot, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(team_id, user_id) DO UPDATE SET
                display_name = COALESCE(excluded.display_name, slack_users.display_name),
                real_name = COALESCE(excluded.real_name, slack_users.real_name),
                is_bot = excluded.is_bot,
                updated_at = excluded.updated_at
          WHERE COALESCE(excluded.display_name, slack_users.display_name) IS NOT slack_users.display_name
            OR COALESCE(excluded.real_name, slack_users.real_name) IS NOT slack_users.real_name
            OR excluded.is_bot IS NOT slack_users.is_bot`,
            )
            .bind(
              input.teamId,
              input.userId,
              input.displayName,
              input.realName,
              Number(input.isBot),
              Date.now(),
            ),
        ),
      );
    }
  }

  async loadMessages(
    teamId: string,
    startMs: number,
    endMs: number,
    threadIds?: string[],
  ): Promise<MessageWithDisplay[]> {
    if (threadIds?.length === 0) return [];
    const selected = threadIds?.map((id) => {
      const [threadTeam, channelId, threadTs] = id.split(":");
      if (threadTeam !== teamId || !channelId || !threadTs)
        throw new Error("Invalid candidate thread identity");
      return { channelId, threadTs };
    });
    const result = await this.db
      .prepare(
        `SELECT
          m.team_id, m.channel_id, m.message_ts, m.thread_ts, m.event_id,
          m.user_id, m.text, m.subtype, m.posted_at, m.event_time,
          m.edited_at, m.deleted_at, c.name AS channel_name,
          COALESCE(u.display_name, u.real_name) AS user_name, u.is_bot
        ${
          selected
            ? // Fix the join order: start with the small batch, then seek each
              // thread's index range instead of scanning the team's retention.
              `FROM json_each(?) target CROSS JOIN slack_messages m
          ON m.channel_id = json_extract(target.value, '$.channelId')
          AND m.thread_ts = json_extract(target.value, '$.threadTs')`
            : "FROM slack_messages m"
        }
        LEFT JOIN slack_channels c
          ON c.team_id = m.team_id AND c.channel_id = m.channel_id
        LEFT JOIN slack_users u
          ON u.team_id = m.team_id AND u.user_id = m.user_id
        WHERE m.team_id = ? AND m.posted_at < ? AND m.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM slack_messages active
            WHERE active.team_id = m.team_id
              AND active.channel_id = m.channel_id
              AND active.thread_ts = m.thread_ts
              AND active.posted_at >= ? AND active.posted_at < ?
              AND active.deleted_at IS NULL AND TRIM(active.text) != ''
          )
        ORDER BY m.posted_at ASC`,
      )
      .bind(
        ...(selected ? [JSON.stringify(selected)] : []),
        teamId,
        endMs,
        startMs,
        endMs,
      )
      .all<MessageRow>();

    return result.results.map(mapMessageRow);
  }

  async searchMessages(input: {
    teamId: string;
    query: string;
    sinceMs: number;
    limit: number;
  }): Promise<MessageWithDisplay[]> {
    const escaped = input.query
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const result = await this.db
      .prepare(
        `SELECT
          m.team_id, m.channel_id, m.message_ts, m.thread_ts, m.event_id,
          m.user_id, m.text, m.subtype, m.posted_at, m.event_time,
          m.edited_at, m.deleted_at, c.name AS channel_name,
          COALESCE(u.display_name, u.real_name) AS user_name, u.is_bot
        FROM slack_messages m
        LEFT JOIN slack_channels c
          ON c.team_id = m.team_id AND c.channel_id = m.channel_id
        LEFT JOIN slack_users u
          ON u.team_id = m.team_id AND u.user_id = m.user_id
        WHERE m.team_id = ?
          AND m.posted_at >= ?
          AND m.deleted_at IS NULL
          AND m.text LIKE ? ESCAPE '\\'
        ORDER BY m.posted_at DESC
        LIMIT ?`,
      )
      .bind(
        input.teamId,
        input.sinceMs,
        `%${escaped}%`,
        Math.min(Math.max(input.limit, 1), 200),
      )
      .all<MessageRow>();

    return result.results.map(mapMessageRow);
  }

  async createDigestRun(input: {
    id: string;
    teamId: string;
    userId: string;
    window: DigestWindow;
  }): Promise<boolean> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO digest_runs (
          id, team_id, user_id, local_date, timezone, window_start, window_end,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        input.id,
        input.teamId,
        input.userId,
        input.window.localDate,
        input.window.timezone,
        input.window.startMs,
        input.window.endMs,
        now,
        now,
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async getDigestRun(id: string): Promise<DigestRunRow | null> {
    return this.db
      .prepare(
        `SELECT
          id, team_id, user_id, local_date, timezone, window_start, window_end,
          workflow_instance_id, status, slack_channel_id, slack_message_ts,
          error
        FROM digest_runs WHERE id = ?`,
      )
      .bind(id)
      .first<DigestRunRow>();
  }

  async listIncompleteDigestRuns(
    teamId: string,
    userId: string,
    withoutJobs = false,
  ): Promise<DigestRunRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, team_id, user_id, local_date, timezone, window_start, window_end,
        workflow_instance_id, status, slack_channel_id, slack_message_ts, error
       FROM digest_runs
       WHERE team_id = ? AND user_id = ? AND status != 'completed'
         AND (? = 0 OR NOT EXISTS (SELECT 1 FROM slack_jobs j WHERE j.run_key = digest_runs.id AND j.sequence = 0))
       ORDER BY local_date ASC LIMIT 25`,
      )
      .bind(teamId, userId, Number(withoutJobs))
      .all<DigestRunRow>();
    return result.results;
  }

  async attachWorkflow(id: string, workflowInstanceId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE digest_runs
        SET workflow_instance_id = ?, status = 'running',
            started_at = COALESCE(started_at, ?),
            error = NULL, updated_at = ?
        WHERE id = ? AND status != 'completed'`,
      )
      .bind(workflowInstanceId, Date.now(), Date.now(), id)
      .run();
  }

  async markDigestRunning(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE digest_runs
        SET status = 'running', started_at = COALESCE(started_at, ?),
            error = NULL, updated_at = ?
        WHERE id = ? AND status != 'completed' AND (status != 'running' OR error IS NOT NULL)`,
      )
      .bind(Date.now(), Date.now(), id)
      .run();
  }

  async saveDigest(input: {
    digestId: string;
    digest: StructuredDigest;
    markdown: string;
    model: string;
    promptVersion: string;
    inputMessageCount: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO daily_digests (
          digest_id, markdown, structured_json, model, prompt_version,
          input_message_count, selected_item_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(digest_id) DO UPDATE SET
          markdown = excluded.markdown,
          structured_json = excluded.structured_json,
          model = excluded.model,
          prompt_version = excluded.prompt_version,
          input_message_count = excluded.input_message_count,
          selected_item_count = excluded.selected_item_count,
          created_at = excluded.created_at`,
      )
      .bind(
        input.digestId,
        input.markdown,
        JSON.stringify(input.digest),
        input.model,
        input.promptVersion,
        input.inputMessageCount,
        input.digest.items.length,
        Date.now(),
      )
      .run();
  }

  async recordDigestDelivery(input: {
    digestId: string;
    channelId: string;
    messageTs: string;
  }): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE digest_runs
        SET status = 'completed', slack_channel_id = ?, slack_message_ts = ?,
            completed_at = ?, updated_at = ?, error = NULL
        WHERE id = ?`,
      )
      .bind(input.channelId, input.messageTs, now, now, input.digestId)
      .run();
  }

  async markDigestFailed(id: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE digest_runs
        SET status = 'failed', error = ?, updated_at = ?
        WHERE id = ? AND status != 'completed'`,
      )
      .bind(error.slice(0, 2_000), Date.now(), id)
      .run();
  }

  async getStoredDigest(
    digestId: string,
  ): Promise<{ markdown: string; structured: StructuredDigest } | null> {
    const row = await this.db
      .prepare(
        `SELECT markdown, structured_json
        FROM daily_digests WHERE digest_id = ?`,
      )
      .bind(digestId)
      .first<{ markdown: string; structured_json: string }>();

    if (!row) return null;
    return {
      markdown: row.markdown,
      structured: JSON.parse(row.structured_json) as StructuredDigest,
    };
  }

  async getLatestDigestForUser(input: {
    teamId: string;
    userId: string;
  }): Promise<{
    digestId: string;
    localDate: string;
    markdown: string;
    structured: StructuredDigest;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT r.id, r.local_date, d.markdown, d.structured_json
        FROM digest_runs r
        JOIN daily_digests d ON d.digest_id = r.id
        WHERE r.team_id = ? AND r.user_id = ?
        ORDER BY r.local_date DESC
        LIMIT 1`,
      )
      .bind(input.teamId, input.userId)
      .first<{
        id: string;
        local_date: string;
        markdown: string;
        structured_json: string;
      }>();

    if (!row) return null;
    return {
      digestId: row.id,
      localDate: row.local_date,
      markdown: row.markdown,
      structured: JSON.parse(row.structured_json) as StructuredDigest,
    };
  }

  async recordFeedback(input: {
    id: string;
    teamId: string;
    userId: string;
    digestId: string | null;
    itemId: string | null;
    value: "relevant" | "not_relevant" | "handled";
    note?: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO feedback_events (
          id, team_id, user_id, digest_id, item_id, value, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.teamId,
        input.userId,
        input.digestId,
        input.itemId,
        input.value,
        input.note ?? null,
        Date.now(),
      )
      .run();
  }

  async saveProfileVersion(input: {
    id: string;
    teamId: string;
    userId: string;
    profile: RelevanceProfile;
    source: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO profile_versions (
          id, team_id, user_id, version, profile_json, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.teamId,
        input.userId,
        input.profile.version,
        JSON.stringify(input.profile),
        input.source,
        Date.now(),
      )
      .run();
  }

  async getChannelSync(teamId: string, channelId: string) {
    return this.db
      .prepare(
        "SELECT history_through,full_scan_through FROM channel_sync_state WHERE team_id = ? AND channel_id = ?",
      )
      .bind(teamId, channelId)
      .first<{ history_through: number; full_scan_through: number | null }>();
  }

  async completeChannelSync(
    teamId: string,
    channelId: string,
    throughMs: number,
    fullScan: boolean,
  ) {
    await this.db
      .prepare(
        `INSERT INTO channel_sync_state (team_id,channel_id,history_through,full_scan_through)
      VALUES (?,?,?,?) ON CONFLICT(team_id,channel_id) DO UPDATE SET
      history_through = MAX(channel_sync_state.history_through,excluded.history_through),
      full_scan_through = CASE WHEN excluded.full_scan_through IS NULL THEN channel_sync_state.full_scan_through
        ELSE MAX(COALESCE(channel_sync_state.full_scan_through,0),excluded.full_scan_through) END
      WHERE excluded.history_through > channel_sync_state.history_through
        OR COALESCE(excluded.full_scan_through,0) > COALESCE(channel_sync_state.full_scan_through,0)`,
      )
      .bind(teamId, channelId, throughMs, fullScan ? throughMs : null)
      .run();
  }

  async activeReplyTargets(teamId: string, startMs: number, endMs: number) {
    const result = await this.db
      .prepare(
        `SELECT DISTINCT channel_id AS channelId,thread_ts AS threadTs
      FROM slack_messages WHERE team_id = ? AND posted_at >= ? AND posted_at < ? AND deleted_at IS NULL
        AND thread_ts != message_ts`,
      )
      .bind(teamId, startMs, endMs)
      .all<{ channelId: string; threadTs: string }>();
    return result.results;
  }

  async updateChannelCursor(input: {
    teamId: string;
    channelId: string;
    latestTs: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO channel_cursors (
          team_id, channel_id, latest_ts, reconciled_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(team_id, channel_id) DO UPDATE SET
          latest_ts = MAX(excluded.latest_ts, channel_cursors.latest_ts),
          reconciled_at = excluded.reconciled_at
        WHERE excluded.latest_ts > channel_cursors.latest_ts`,
      )
      .bind(input.teamId, input.channelId, input.latestTs, Date.now())
      .run();
  }

  async deleteExpiredData(beforeMs: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("DELETE FROM slack_events WHERE received_at < ?")
        .bind(beforeMs),
      this.db
        .prepare("DELETE FROM slack_messages WHERE posted_at < ?")
        .bind(beforeMs),
    ]);
  }

  private messageStatements(message: SlackMessage): D1PreparedStatement[] {
    const now = Date.now();
    return [
      ...(!message.eventId.startsWith("history:")
        ? [
            this.db
              .prepare(
                `INSERT OR IGNORE INTO slack_events (
            event_id, team_id, event_type, received_at
          ) VALUES (?, ?, ?, ?)`,
              )
              .bind(message.eventId, message.teamId, "message", now),
          ]
        : []),
      this.db
        .prepare(
          `INSERT INTO slack_messages (
            team_id, channel_id, message_ts, thread_ts, event_id, user_id,
            text, subtype, posted_at, event_time, edited_at, deleted_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(team_id, channel_id, message_ts) DO UPDATE SET
            thread_ts = CASE
              WHEN excluded.event_time >= slack_messages.event_time
                THEN excluded.thread_ts
              ELSE slack_messages.thread_ts
            END,
            event_id = CASE
              WHEN excluded.event_time >= slack_messages.event_time
                THEN excluded.event_id
              ELSE slack_messages.event_id
            END,
            user_id = COALESCE(excluded.user_id, slack_messages.user_id),
            text = CASE
              WHEN excluded.event_time >= slack_messages.event_time
                THEN excluded.text
              ELSE slack_messages.text
            END,
            subtype = CASE
              WHEN excluded.event_time >= slack_messages.event_time
                THEN excluded.subtype
              ELSE slack_messages.subtype
            END,
            event_time = MAX(excluded.event_time, slack_messages.event_time),
            edited_at = NULLIF(
              MAX(
                COALESCE(excluded.edited_at, 0),
                COALESCE(slack_messages.edited_at, 0)
              ),
              0
            ),
            deleted_at = COALESCE(
              slack_messages.deleted_at,
              excluded.deleted_at
            ),
            updated_at = excluded.updated_at
          WHERE (excluded.event_time >= slack_messages.event_time AND (
            excluded.event_time > slack_messages.event_time
            OR excluded.thread_ts IS NOT slack_messages.thread_ts
            OR excluded.text IS NOT slack_messages.text
            OR excluded.subtype IS NOT slack_messages.subtype
          )) OR COALESCE(excluded.user_id, slack_messages.user_id) IS NOT slack_messages.user_id
            OR COALESCE(excluded.edited_at, 0) > COALESCE(slack_messages.edited_at, 0)
            OR (slack_messages.deleted_at IS NULL AND excluded.deleted_at IS NOT NULL)`,
        )
        .bind(
          message.teamId,
          message.channelId,
          message.messageTs,
          message.threadTs,
          message.eventId,
          message.userId,
          message.text,
          message.subtype,
          message.postedAt,
          message.eventTime,
          message.editedAt,
          message.deletedAt,
          now,
          now,
        ),
    ];
  }
}

function mapMessageRow(row: MessageRow): MessageWithDisplay {
  return {
    teamId: row.team_id,
    channelId: row.channel_id,
    messageTs: row.message_ts,
    threadTs: row.thread_ts,
    eventId: row.event_id ?? `stored:${row.channel_id}:${row.message_ts}`,
    eventTime: row.event_time,
    postedAt: row.posted_at,
    userId: row.user_id,
    text: row.text,
    subtype: row.subtype,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    channelName: row.channel_name,
    userName: row.user_name,
    isBot: row.is_bot === 1,
  };
}

function slackTimestampMs(timestamp: string): number {
  const value = Number.parseFloat(timestamp);
  return Number.isFinite(value) ? Math.round(value * 1_000) : Date.now();
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
