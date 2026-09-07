import { sha256 } from "../domain/hash";
import type {
  ChangeEvent,
  CollectedItem,
  CollectionResult,
  DigestWindow,
  EditorialDigest,
  FeedbackValue,
  JsonValue,
  PreferenceProfile,
  SourceDefinition,
  SourceState,
} from "../domain/types";

type SourceStateRow = {
  source_id: string;
  etag: string | null;
  last_modified: string | null;
  cursor: string | null;
  baselined: number;
  last_checked_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
};

type ChangeEventRow = {
  id: string;
  source_id: string;
  source_name: string;
  source_category: ChangeEvent["sourceCategory"];
  source_authority: number;
  external_id: string;
  change_type: ChangeEvent["changeType"];
  canonical_url: string;
  title: string;
  content: string;
  content_hash: string;
  artifact_key: string | null;
  published_at: number | null;
  detected_at: number;
  metadata_json: string;
};

export type DigestRun = {
  id: string;
  localDate: string;
  status: "pending" | "running" | "completed" | "failed";
  providerMessageId: string | null;
  hasRenderedEmail: boolean;
};

export type PendingDigestRun = DigestRun & {
  window: DigestWindow;
};

const DEFAULT_PROFILE: PreferenceProfile = {
  positiveExamples: [],
  negativeExamples: [],
  preferredFormats: [],
  version: 1,
};

export class ChangelogRepository {
  constructor(private readonly db: D1Database) {}

  async syncSources(sources: readonly SourceDefinition[]): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare("UPDATE sources SET enabled = 0, updated_at = ?")
      .bind(now)
      .run();
    for (const chunk of chunks([...sources], 50)) {
      await this.db.batch(
        chunk.flatMap((source) => [
          this.db
            .prepare(
              `INSERT INTO sources (
                id, name, kind, category, url, canonical_url,
                poll_interval_minutes, authority, options_json,
                enabled, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                kind = excluded.kind,
                category = excluded.category,
                url = excluded.url,
                canonical_url = excluded.canonical_url,
                poll_interval_minutes = excluded.poll_interval_minutes,
                authority = excluded.authority,
                options_json = excluded.options_json,
                enabled = 1,
                updated_at = excluded.updated_at`,
            )
            .bind(
              source.id,
              source.name,
              source.kind,
              source.category,
              source.url,
              source.canonicalUrl,
              source.pollIntervalMinutes,
              source.authority,
              JSON.stringify(source.options ?? {}),
              now,
              now,
            ),
          this.db
            .prepare(
              `INSERT OR IGNORE INTO source_state (
                source_id, baselined, consecutive_failures
              ) VALUES (?, 0, 0)`,
            )
            .bind(source.id),
        ]),
      );
    }
  }

  async dueSourceIds(nowMs: number): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT s.id
        FROM sources s
        JOIN source_state state ON state.source_id = s.id
        WHERE s.enabled = 1
          AND (
            state.last_checked_at IS NULL
            OR state.last_checked_at + s.poll_interval_minutes * 60000 <= ?
          )
        ORDER BY COALESCE(state.last_checked_at, 0), s.authority DESC`,
      )
      .bind(nowMs)
      .all<{ id: string }>();
    return result.results.map((row) => row.id);
  }

  async hasBaselinedSource(): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS ready
        FROM sources source
        JOIN source_state state ON state.source_id = source.id
        WHERE source.enabled = 1 AND state.baselined = 1`,
      )
      .first<{ ready: number }>();
    return (row?.ready ?? 0) > 0;
  }

  async sourceState(sourceId: string): Promise<SourceState> {
    const row = await this.db
      .prepare(
        `SELECT source_id, etag, last_modified, cursor, baselined,
          last_checked_at, last_success_at, last_error, consecutive_failures
        FROM source_state WHERE source_id = ?`,
      )
      .bind(sourceId)
      .first<SourceStateRow>();
    if (!row) throw new Error(`Source state does not exist: ${sourceId}`);
    return {
      sourceId: row.source_id,
      etag: row.etag,
      lastModified: row.last_modified,
      cursor: row.cursor,
      baselined: row.baselined === 1,
      lastCheckedAt: row.last_checked_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
    };
  }

  async applyCollection(
    source: SourceDefinition,
    state: SourceState,
    collection: CollectionResult,
  ): Promise<{ created: number; updated: number }> {
    const now = Date.now();
    const existingResult = await this.db
      .prepare(
        `SELECT external_id, content_hash
        FROM source_items WHERE source_id = ?`,
      )
      .bind(source.id)
      .all<{ external_id: string; content_hash: string }>();
    const existing = new Map(
      existingResult.results.map((row) => [row.external_id, row.content_hash]),
    );

    let created = 0;
    let updated = 0;
    const statements: D1PreparedStatement[] = [];
    for (const item of collection.items) {
      const previousHash = existing.get(item.externalId);
      const isCreated = previousHash === undefined;
      const isUpdated =
        previousHash !== undefined && previousHash !== item.contentHash;
      if (isCreated) created += 1;
      if (isUpdated) updated += 1;

      statements.push(this.upsertItemStatement(item, now));
      if (state.baselined && (isCreated || isUpdated)) {
        statements.push(
          await this.changeEventStatement(
            source,
            item,
            isCreated ? "created" : changeType(item),
            now,
          ),
        );
      }
    }

    for (const chunk of chunks(statements, 100)) {
      await this.db.batch(chunk);
    }
    await this.db
      .prepare(
        `UPDATE source_state
        SET etag = ?, last_modified = ?, cursor = ?, baselined = 1,
            last_checked_at = ?, last_success_at = ?, last_error = NULL,
            consecutive_failures = 0,
            snapshot_key = COALESCE(?, snapshot_key)
        WHERE source_id = ?`,
      )
      .bind(
        collection.etag,
        collection.lastModified,
        collection.cursor,
        now,
        now,
        collection.snapshot ? `sources/${source.id}/latest` : null,
        source.id,
      )
      .run();
    return { created, updated };
  }

  async markSourceFailure(sourceId: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE source_state
        SET last_checked_at = ?, last_error = ?,
            consecutive_failures = consecutive_failures + 1
        WHERE source_id = ?`,
      )
      .bind(Date.now(), error.slice(0, 2_000), sourceId)
      .run();
  }

  async createDigestRun(input: {
    id: string;
    window: DigestWindow;
  }): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO digest_runs (
          id, local_date, timezone, window_start, window_end, status,
          email_idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.window.localDate,
        input.window.timezone,
        input.window.startMs,
        input.window.endMs,
        `changelog-buddy/${input.window.localDate}`,
        now,
        now,
      )
      .run();
  }

  async digestRun(id: string): Promise<DigestRun | null> {
    const row = await this.db
      .prepare(
        `SELECT id, local_date, status, provider_message_id,
          CASE WHEN html IS NULL THEN 0 ELSE 1 END AS has_rendered_email
        FROM digest_runs WHERE id = ?`,
      )
      .bind(id)
      .first<{
        id: string;
        local_date: string;
        status: DigestRun["status"];
        provider_message_id: string | null;
        has_rendered_email: number;
      }>();
    return row
      ? {
          id: row.id,
          localDate: row.local_date,
          status: row.status,
          providerMessageId: row.provider_message_id,
          hasRenderedEmail: row.has_rendered_email === 1,
        }
      : null;
  }

  async incompleteDigestRuns(limit = 10): Promise<PendingDigestRun[]> {
    const result = await this.db
      .prepare(
        `SELECT id, local_date, timezone, window_start, window_end, status,
          provider_message_id,
          CASE WHEN html IS NULL THEN 0 ELSE 1 END AS has_rendered_email
        FROM digest_runs
        WHERE status != 'completed'
        ORDER BY local_date ASC
        LIMIT ?`,
      )
      .bind(limit)
      .all<{
        id: string;
        local_date: string;
        timezone: string;
        window_start: number;
        window_end: number;
        status: DigestRun["status"];
        provider_message_id: string | null;
        has_rendered_email: number;
      }>();
    return result.results.map((row) => ({
      id: row.id,
      localDate: row.local_date,
      status: row.status,
      providerMessageId: row.provider_message_id,
      hasRenderedEmail: row.has_rendered_email === 1,
      window: {
        localDate: row.local_date,
        timezone: row.timezone,
        startMs: row.window_start,
        endMs: row.window_end,
      },
    }));
  }

  async markDigestRunning(id: string): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE digest_runs
        SET status = 'running', started_at = COALESCE(started_at, ?),
            last_error = NULL, updated_at = ?
        WHERE id = ?`,
      )
      .bind(now, now, id)
      .run();
  }

  async changesForWindow(
    startMs: number,
    endMs: number,
  ): Promise<ChangeEvent[]> {
    const result = await this.db
      .prepare(
        `SELECT
          event.id, event.source_id, source.name AS source_name,
          source.category AS source_category,
          source.authority AS source_authority, event.external_id,
          event.change_type, event.canonical_url, event.title, event.content,
          event.content_hash, event.artifact_key, event.published_at,
          event.detected_at, event.metadata_json
        FROM change_events event
        JOIN sources source ON source.id = event.source_id
        WHERE event.status = 'new'
          AND event.detected_at >= ? AND event.detected_at < ?
        ORDER BY source.authority DESC, event.detected_at DESC`,
      )
      .bind(startMs, endMs)
      .all<ChangeEventRow>();
    return result.results.map(mapChangeEvent);
  }

  async sourceHealth(): Promise<
    Array<{
      id: string;
      name: string;
      lastSuccessAt: number | null;
      lastError: string | null;
      consecutiveFailures: number;
    }>
  > {
    const result = await this.db
      .prepare(
        `SELECT source.id, source.name, state.last_success_at,
          state.last_error, state.consecutive_failures
        FROM sources source
        JOIN source_state state ON state.source_id = source.id
        WHERE source.enabled = 1
        ORDER BY source.authority DESC, source.name`,
      )
      .all<{
        id: string;
        name: string;
        last_success_at: number | null;
        last_error: string | null;
        consecutive_failures: number;
      }>();
    return result.results.map((row) => ({
      id: row.id,
      name: row.name,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
    }));
  }

  async preferenceProfile(): Promise<PreferenceProfile> {
    const row = await this.db
      .prepare(
        `SELECT profile_json FROM preference_profile WHERE id = 'default'`,
      )
      .first<{ profile_json: string }>();
    return row
      ? (JSON.parse(row.profile_json) as PreferenceProfile)
      : structuredClone(DEFAULT_PROFILE);
  }

  async saveDigest(input: {
    digestId: string;
    model: string;
    subject: string;
    digest: EditorialDigest;
    html: string;
    text: string;
  }): Promise<void> {
    const now = Date.now();
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE digest_runs
          SET model = ?, subject = ?, overview = ?, structured_json = ?,
              html = ?, text = ?, updated_at = ?
          WHERE id = ?`,
        )
        .bind(
          input.model,
          input.subject,
          input.digest.overview,
          JSON.stringify(input.digest),
          input.html,
          input.text,
          now,
          input.digestId,
        ),
      ...input.digest.items.map((item, index) =>
        this.db
          .prepare(
            `INSERT INTO digest_items (
              digest_id, item_id, rank, editorial_json, source_event_ids_json
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(digest_id, item_id) DO UPDATE SET
              rank = excluded.rank,
              editorial_json = excluded.editorial_json,
              source_event_ids_json = excluded.source_event_ids_json`,
          )
          .bind(
            input.digestId,
            item.id,
            index,
            JSON.stringify(item),
            JSON.stringify(item.eventIds),
          ),
      ),
    ];
    for (const chunk of chunks(statements, 100)) {
      await this.db.batch(chunk);
    }
  }

  async markDigestDelivered(
    digestId: string,
    providerMessageId: string,
    includedEventIds: string[],
    allEventIds: string[],
  ): Promise<void> {
    const now = Date.now();
    const included = new Set(includedEventIds);
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE digest_runs
          SET status = 'completed', provider_message_id = ?,
              completed_at = ?, updated_at = ?, last_error = NULL
          WHERE id = ?`,
        )
        .bind(providerMessageId, now, now, digestId),
      ...allEventIds.map((eventId) =>
        this.db
          .prepare(
            `UPDATE change_events
            SET status = ?, digest_id = ?
            WHERE id = ?`,
          )
          .bind(
            included.has(eventId) ? "included" : "ignored",
            digestId,
            eventId,
          ),
      ),
    ];
    for (const chunk of chunks(statements, 100)) {
      await this.db.batch(chunk);
    }
  }

  async markDigestSkippedNoUpdates(id: string): Promise<void> {
    const now = Date.now();
    const digest: EditorialDigest = {
      overview:
        "No new public Mistral changes were detected during this coverage window. Email delivery was skipped.",
      items: [],
    };
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE digest_runs
          SET status = 'completed', model = 'not-used', subject = NULL,
              overview = ?, structured_json = ?, html = NULL, text = NULL,
              provider_message_id = NULL, completed_at = ?, updated_at = ?,
              last_error = NULL
          WHERE id = ?`,
        )
        .bind(digest.overview, JSON.stringify(digest), now, now, id),
      this.db.prepare("DELETE FROM digest_items WHERE digest_id = ?").bind(id),
    ]);
  }

  async markDigestFailed(id: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE digest_runs
        SET status = 'failed', last_error = ?, updated_at = ?
        WHERE id = ?`,
      )
      .bind(error.slice(0, 2_000), Date.now(), id)
      .run();
  }

  async recordFeedback(input: {
    id: string;
    digestId: string;
    itemId: string;
    value: FeedbackValue;
  }): Promise<boolean> {
    const item = await this.db
      .prepare(
        `SELECT editorial_json FROM digest_items
        WHERE digest_id = ? AND item_id = ?`,
      )
      .bind(input.digestId, input.itemId)
      .first<{ editorial_json: string }>();
    if (!item) return false;

    await this.db
      .prepare(
        `INSERT OR IGNORE INTO feedback_events (
          id, digest_id, item_id, value, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(input.id, input.digestId, input.itemId, input.value, Date.now())
      .run();
    if (input.value === "handled") return true;

    const editorial = JSON.parse(item.editorial_json) as {
      title?: string;
      developerImpact?: string;
      recommendedFormats?: PreferenceProfile["preferredFormats"];
    };
    const profile = await this.preferenceProfile();
    const example = `${editorial.title ?? input.itemId}: ${
      editorial.developerImpact ?? ""
    }`.slice(0, 400);
    const positive =
      input.value === "pursue"
        ? appendUnique(profile.positiveExamples, example)
        : profile.positiveExamples.filter((value) => value !== example);
    const negative =
      input.value === "not_relevant"
        ? appendUnique(profile.negativeExamples, example)
        : profile.negativeExamples.filter((value) => value !== example);
    const preferredFormats =
      input.value === "pursue"
        ? [
            ...new Set([
              ...profile.preferredFormats,
              ...(editorial.recommendedFormats ?? []),
            ]),
          ]
        : profile.preferredFormats;
    const updated: PreferenceProfile = {
      positiveExamples: positive,
      negativeExamples: negative,
      preferredFormats,
      version: profile.version + 1,
    };
    await this.db
      .prepare(
        `INSERT INTO preference_profile (
          id, profile_json, version, updated_at
        ) VALUES ('default', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          profile_json = excluded.profile_json,
          version = excluded.version,
          updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(updated), updated.version, Date.now())
      .run();
    return true;
  }

  async deleteExpiredChanges(beforeMs: number): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM change_events
        WHERE detected_at < ? AND status != 'new'`,
      )
      .bind(beforeMs)
      .run();
  }

  private upsertItemStatement(
    item: CollectedItem,
    now: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO source_items (
          source_id, external_id, canonical_url, title, published_at,
          updated_at, content, content_hash, artifact_key, metadata_json,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, external_id) DO UPDATE SET
          canonical_url = excluded.canonical_url,
          title = excluded.title,
          published_at = COALESCE(excluded.published_at, source_items.published_at),
          updated_at = COALESCE(excluded.updated_at, source_items.updated_at),
          content = excluded.content,
          content_hash = excluded.content_hash,
          artifact_key = excluded.artifact_key,
          metadata_json = excluded.metadata_json,
          last_seen_at = excluded.last_seen_at`,
      )
      .bind(
        item.sourceId,
        item.externalId,
        item.canonicalUrl,
        item.title,
        item.publishedAt,
        item.updatedAt,
        item.content,
        item.contentHash,
        item.artifactKey,
        JSON.stringify(item.metadata),
        now,
        now,
      );
  }

  private async changeEventStatement(
    source: SourceDefinition,
    item: CollectedItem,
    type: ChangeEvent["changeType"],
    now: number,
  ): Promise<D1PreparedStatement> {
    const externalHash = (await sha256(item.externalId)).slice(0, 20);
    const id = `${source.id}:${externalHash}:${item.contentHash.slice(0, 20)}`;
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO change_events (
          id, source_id, external_id, change_type, canonical_url, title,
          content, content_hash, artifact_key, published_at, detected_at,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        source.id,
        item.externalId,
        type,
        item.canonicalUrl,
        item.title,
        item.content,
        item.contentHash,
        item.artifactKey,
        item.publishedAt,
        now,
        JSON.stringify(item.metadata),
      );
  }
}

function changeType(item: CollectedItem): ChangeEvent["changeType"] {
  if (item.metadata.yanked === true) return "yanked";
  if (
    typeof item.metadata.deprecated === "string" &&
    item.metadata.deprecated
  ) {
    return "deprecated";
  }
  return "updated";
}

function mapChangeEvent(row: ChangeEventRow): ChangeEvent {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceCategory: row.source_category,
    sourceAuthority: row.source_authority,
    externalId: row.external_id,
    changeType: row.change_type,
    canonicalUrl: row.canonical_url,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    artifactKey: row.artifact_key,
    publishedAt: row.published_at,
    detectedAt: row.detected_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, JsonValue>,
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function appendUnique(values: string[], value: string): string[] {
  return [...values.filter((existing) => existing !== value), value].slice(-30);
}
