/**
 * Durable Object SQLite schema and accessors.
 *
 * Single source of truth for the agent. There is no D1 binding; the sweep runs
 * in-agent and writes here directly.
 */

export type Sql = <T = Record<string, string | number | boolean | null>>(
	strings: TemplateStringsArray,
	...values: (string | number | boolean | null)[]
) => T[];

export const TOP_LEVEL_CURSOR = "toplevel";
export const LAST_ACTIVITY = "last_activity_at";
export const LAST_DIGEST = "last_digest_at";

/**
 * Opaque `Thread: N replies (latest: ...)` value, used only to detect change.
 * It is a formatted local datetime, not a timestamp, so it is never ordered.
 */
export const threadSignatureKey = (parentTs: string) => `threadsig:${parentTs}`;

/** Highest reply timestamp already handled in a thread. */
export const threadWatermarkKey = (parentTs: string) => `threadwm:${parentTs}`;

const SEEN_ITEM_TTL_DAYS = 30;
const SENT_LEDGER_TTL_DAYS = 30;

export type DigestStatus = "ok" | "empty" | "failed";

export class Store {
	constructor(private readonly sql: Sql) {}

	migrate(): void {
		this.sql`
			CREATE TABLE IF NOT EXISTS sent_ledger (
				ts TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS seen_items (
				key TEXT PRIMARY KEY,
				first_seen INTEGER NOT NULL
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS cursors (
				surface TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS watchlist (
				topic TEXT PRIMARY KEY,
				aliases TEXT NOT NULL DEFAULT '',
				active INTEGER NOT NULL DEFAULT 1,
				created_at INTEGER NOT NULL
			)
		`;
		// One row per briefing item posted, so a reaction on that message can
		// be traced back to the query term and channel that produced it.
		this.sql`
			CREATE TABLE IF NOT EXISTS digest_items (
				ts TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				source_key TEXT NOT NULL,
				term TEXT NOT NULL,
				channel TEXT NOT NULL DEFAULT '',
				posted_at INTEGER NOT NULL,
				harvested INTEGER NOT NULL DEFAULT 0
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS topic_signals (
				term TEXT PRIMARY KEY,
				positive INTEGER NOT NULL DEFAULT 0,
				negative INTEGER NOT NULL DEFAULT 0,
				last_seen INTEGER NOT NULL
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS digest_runs (
				id TEXT PRIMARY KEY,
				started_at INTEGER NOT NULL,
				finished_at INTEGER,
				status TEXT,
				item_count INTEGER NOT NULL DEFAULT 0,
				note TEXT
			)
		`;
	}

	// ---------------------------------------------------------- sent ledger

	/**
	 * Record a message the agent sent.
	 *
	 * Must be called before the cursor advances. Inside a thread the agent's
	 * own messages carry the owner's author id and are otherwise
	 * indistinguishable from input, so this ledger is the loop guard.
	 */
	recordSent(ts: string, now = Date.now()): void {
		this.sql`
			INSERT OR IGNORE INTO sent_ledger (ts, created_at) VALUES (${ts}, ${now})
		`;
	}

	isSent(ts: string): boolean {
		return this.sql<{ ts: string }>`
			SELECT ts FROM sent_ledger WHERE ts = ${ts} LIMIT 1
		`.length > 0;
	}

	// ------------------------------------------------------------- cursors

	getCursor(surface: string): string | null {
		const rows = this.sql<{ value: string }>`
			SELECT value FROM cursors WHERE surface = ${surface} LIMIT 1
		`;
		return rows[0]?.value ?? null;
	}

	setCursor(surface: string, value: string, now = Date.now()): void {
		this.sql`
			INSERT INTO cursors (surface, value, updated_at)
			VALUES (${surface}, ${value}, ${now})
			ON CONFLICT(surface) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
		`;
	}

	// ----------------------------------------------------------- seen items

	hasSeen(key: string): boolean {
		return this.sql<{ key: string }>`
			SELECT key FROM seen_items WHERE key = ${key} LIMIT 1
		`.length > 0;
	}

	markSeen(keys: string[], now = Date.now()): void {
		for (const key of keys) {
			this.sql`
				INSERT OR IGNORE INTO seen_items (key, first_seen) VALUES (${key}, ${now})
			`;
		}
	}

	// ------------------------------------------------------------ watchlist

	activeTopics(): string[] {
		return this.sql<{ topic: string }>`
			SELECT topic FROM watchlist WHERE active = 1 ORDER BY created_at
		`.map((r) => r.topic);
	}

	addTopic(topic: string, aliases = "", now = Date.now()): void {
		this.sql`
			INSERT INTO watchlist (topic, aliases, active, created_at)
			VALUES (${topic}, ${aliases}, 1, ${now})
			ON CONFLICT(topic) DO UPDATE SET active = 1, aliases = excluded.aliases
		`;
	}

	removeTopic(topic: string): void {
		this.sql`UPDATE watchlist SET active = 0 WHERE topic = ${topic}`;
	}

	// ---------------------------------------------------------- digest runs

	startDigestRun(id: string, now = Date.now()): void {
		this.sql`
			INSERT OR IGNORE INTO digest_runs (id, started_at) VALUES (${id}, ${now})
		`;
	}

	finishDigestRun(
		id: string,
		status: DigestStatus,
		itemCount: number,
		note = "",
		now = Date.now(),
	): void {
		this.sql`
			UPDATE digest_runs
			SET finished_at = ${now}, status = ${status}, item_count = ${itemCount}, note = ${note}
			WHERE id = ${id}
		`;
	}

	/**
	 * Recent runs, including empty and failed ones.
	 *
	 * Quiet days are silent, so silence alone cannot distinguish "nothing
	 * happened" from "the sweep crashed". This makes that answerable when the
	 * owner asks in the DM.
	 */
	recentRuns(limit = 7): Array<{
		id: string;
		started_at: number;
		finished_at: number | null;
		status: string | null;
		item_count: number;
		note: string | null;
	}> {
		return this.sql`
			SELECT id, started_at, finished_at, status, item_count, note
			FROM digest_runs ORDER BY started_at DESC LIMIT ${limit}
		` as never;
	}

	// --------------------------------------------------- items and signals

	recordDigestItem(item: {
		ts: string;
		runId: string;
		sourceKey: string;
		term: string;
		channel: string;
		now?: number;
	}): void {
		this.sql`
			INSERT OR IGNORE INTO digest_items (ts, run_id, source_key, term, channel, posted_at)
			VALUES (${item.ts}, ${item.runId}, ${item.sourceKey}, ${item.term}, ${item.channel}, ${item.now ?? Date.now()})
		`;
	}

	/**
	 * Items still awaiting a reaction check.
	 *
	 * Harvesting is deferred to the next run so the owner has a full day to
	 * react. Each item is read at most once, which bounds the extra calls.
	 */
	pendingFeedback(limit = 20): Array<{ ts: string; term: string; channel: string }> {
		return this.sql`
			SELECT ts, term, channel FROM digest_items
			WHERE harvested = 0 ORDER BY posted_at LIMIT ${limit}
		` as never;
	}

	markHarvested(ts: string): void {
		this.sql`UPDATE digest_items SET harvested = 1 WHERE ts = ${ts}`;
	}

	bumpSignal(term: string, verdict: "useful" | "noise", now = Date.now()): void {
		const positive = verdict === "useful" ? 1 : 0;
		const negative = verdict === "noise" ? 1 : 0;
		this.sql`
			INSERT INTO topic_signals (term, positive, negative, last_seen)
			VALUES (${term}, ${positive}, ${negative}, ${now})
			ON CONFLICT(term) DO UPDATE SET
				positive = topic_signals.positive + ${positive},
				negative = topic_signals.negative + ${negative},
				last_seen = ${now}
		`;
	}

	signals(): Array<{ term: string; positive: number; negative: number }> {
		return this.sql`
			SELECT term, positive, negative FROM topic_signals
			ORDER BY (positive - negative) DESC, last_seen DESC
		` as never;
	}

	// ------------------------------------------------------------- pruning

	prune(now = Date.now()): void {
		const seenCutoff = now - SEEN_ITEM_TTL_DAYS * 86_400_000;
		const sentCutoff = now - SENT_LEDGER_TTL_DAYS * 86_400_000;
		this.sql`DELETE FROM seen_items WHERE first_seen < ${seenCutoff}`;
		this.sql`DELETE FROM sent_ledger WHERE created_at < ${sentCutoff}`;
	}
}
