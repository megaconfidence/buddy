import type { BriefingItem } from "./digest/types";
import { DEFAULT_PROFILE, type PreferenceProfile, type Verdict } from "./feedback";

/**
 * Durable Object SQLite schema and accessors.
 *
 * Single source of truth for the agent. There is no D1 binding; the sweep runs
 * in-agent and writes here directly.
 *
 * No Slack message text is stored. The digest reads conversations in memory
 * during a run; what persists is the briefing the model wrote, thread keys and
 * timestamps for de-duplication, and the owner's preferences.
 */

export type Sql = <T = Record<string, string | number | boolean | null>>(
	strings: TemplateStringsArray,
	...values: (string | number | boolean | null)[]
) => T[];

export const TOP_LEVEL_CURSOR = "toplevel";
export const LAST_ACTIVITY = "last_activity_at";
export const LAST_DIGEST = "last_digest_at";
export const LAST_MANUAL_BRIEFING = "last_manual_briefing_at";
/** Epoch ms until which upstream rate limiting is assumed to persist. */
export const RATE_LIMITED_UNTIL = "rate_limited_until";
/** Epoch ms until which the primary model is assumed unavailable. */
export const MODEL_FALLBACK_UNTIL = "model_fallback_until";
/** Run id of the latest delivered briefing; item numbers in conversation refer to it. */
export const LAST_BRIEFING_RUN = "last_briefing_run";
/** Slack ts of the latest briefing message, so the poller keeps watching its thread. */
export const LAST_BRIEFING_TS = "last_briefing_ts";
/** Slack workspace host learned from search permalinks, for building links. */
export const WORKSPACE_HOST = "workspace_host";
/** Epoch ms when the Slack connection was first seen not ready; absent while it is. */
export const SLACK_DOWN_SINCE = "slack_down_since";
/** Epoch ms of the last reconnect attempt, and how many since the outage began. */
export const SLACK_RECONNECT_AT = "slack_reconnect_at";
export const SLACK_RECONNECT_ATTEMPTS = "slack_reconnect_attempts";
/** JSON `MissedBriefing`: a briefing that did not go out and still needs catching up. */
export const MISSED_BRIEFING = "missed_briefing";

/**
 * Opaque `Thread: N replies (latest: ...)` value, used only to detect change.
 * It is a formatted local datetime, not a timestamp, so it is never ordered.
 */
export const threadSignatureKey = (parentTs: string) => `threadsig:${parentTs}`;

/** Highest reply timestamp already handled in a thread. */
export const threadWatermarkKey = (parentTs: string) => `threadwm:${parentTs}`;

const SENT_LEDGER_TTL_DAYS = 30;
const BRIEFED_THREAD_TTL_DAYS = 30;
const BRIEFING_ITEM_TTL_DAYS = 60;

export type DigestStatus = "ok" | "empty" | "failed";

export type StoredBriefingItem = BriefingItem & {
	runId: string;
	verdict: Verdict | null;
	createdAt: number;
};

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
		// One row per numbered item of a delivered briefing. This is what "more
		// on 3" resolves against, and what the editor reads to avoid repeating
		// itself.
		this.sql`
			CREATE TABLE IF NOT EXISTS briefing_items (
				run_id TEXT NOT NULL,
				number INTEGER NOT NULL,
				section TEXT NOT NULL,
				text TEXT NOT NULL,
				item_json TEXT NOT NULL,
				verdict TEXT,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (run_id, number)
			)
		`;
		// Thread-level de-duplication: a conversation that was briefed is skipped
		// until it gets a message newer than `latest_ts`.
		this.sql`
			CREATE TABLE IF NOT EXISTS briefed_threads (
				key TEXT PRIMARY KEY,
				latest_ts TEXT NOT NULL,
				headline TEXT NOT NULL,
				briefed_at INTEGER NOT NULL
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS focus_channels (
				channel_id TEXT PRIMARY KEY,
				name TEXT NOT NULL DEFAULT '',
				added_at INTEGER NOT NULL
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS preferences (
				id TEXT PRIMARY KEY,
				profile_json TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		// When each channel was last suggested as a focus channel, so a tip is
		// not repeated every morning.
		this.sql`
			CREATE TABLE IF NOT EXISTS focus_suggestions (
				channel_id TEXT PRIMARY KEY,
				name TEXT NOT NULL DEFAULT '',
				suggested_at INTEGER NOT NULL
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

	deleteCursor(surface: string): void {
		this.sql`DELETE FROM cursors WHERE surface = ${surface}`;
	}

	workspaceHost(): string | null {
		return this.getCursor(WORKSPACE_HOST);
	}

	setWorkspaceHost(host: string): void {
		this.setCursor(WORKSPACE_HOST, host);
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

	// ------------------------------------------------------- focus channels

	focusChannels(): Array<{ channelId: string; name: string }> {
		return this.sql<{ channel_id: string; name: string }>`
			SELECT channel_id, name FROM focus_channels ORDER BY added_at
		`.map((r) => ({ channelId: r.channel_id, name: r.name }));
	}

	addFocusChannel(channelId: string, name: string, now = Date.now()): void {
		this.sql`
			INSERT INTO focus_channels (channel_id, name, added_at) VALUES (${channelId}, ${name}, ${now})
			ON CONFLICT(channel_id) DO UPDATE SET name = CASE WHEN excluded.name = '' THEN focus_channels.name ELSE excluded.name END
		`;
	}

	/** Remove by id or by name. Returns whether anything was removed. */
	removeFocusChannel(idOrName: string): boolean {
		const target = idOrName.replace(/^#/, "");
		const before = this.focusChannels().length;
		this.sql`DELETE FROM focus_channels WHERE channel_id = ${target} OR name = ${target}`;
		return this.focusChannels().length < before;
	}

	/**
	 * A channel's id from its name, as seen in recent briefing sources. Lets
	 * "focus on #launches" work without a channel search, for any channel a
	 * briefing has cited.
	 */
	knownChannelId(name: string): string | null {
		const target = name.replace(/^#/, "").toLowerCase();
		for (const item of this.briefingItemsSince(0)) {
			const source = item.sources.find((s) => s.channelName?.toLowerCase() === target);
			if (source) return source.channelId;
		}
		return null;
	}

	markFocusSuggested(channelId: string, name: string, now = Date.now()): void {
		this.sql`
			INSERT INTO focus_suggestions (channel_id, name, suggested_at) VALUES (${channelId}, ${name}, ${now})
			ON CONFLICT(channel_id) DO UPDATE SET name = excluded.name, suggested_at = excluded.suggested_at
		`;
	}

	focusSuggestedSince(sinceMs: number): Set<string> {
		return new Set(
			this.sql<{ channel_id: string }>`
				SELECT channel_id FROM focus_suggestions WHERE suggested_at >= ${sinceMs}
			`.map((r) => r.channel_id),
		);
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

	// ------------------------------------------------------ briefing items

	saveBriefing(runId: string, items: BriefingItem[], now = Date.now()): void {
		for (const item of items) {
			this.sql`
				INSERT OR REPLACE INTO briefing_items (run_id, number, section, text, item_json, created_at)
				VALUES (${runId}, ${item.number}, ${item.section}, ${item.text}, ${JSON.stringify(item)}, ${now})
			`;
		}
	}

	private hydrate(row: { run_id: string; item_json: string; verdict: string | null; created_at: number }): StoredBriefingItem {
		return {
			...(JSON.parse(row.item_json) as BriefingItem),
			runId: row.run_id,
			verdict: row.verdict as Verdict | null,
			createdAt: row.created_at,
		};
	}

	/** Items of the latest delivered briefing, in display order. */
	latestBriefingItems(): StoredBriefingItem[] {
		const runId = this.getCursor(LAST_BRIEFING_RUN);
		if (!runId) return [];
		return this.sql<{ run_id: string; item_json: string; verdict: string | null; created_at: number }>`
			SELECT run_id, item_json, verdict, created_at FROM briefing_items
			WHERE run_id = ${runId} ORDER BY number
		`.map((row) => this.hydrate(row));
	}

	briefingItem(number: number): StoredBriefingItem | null {
		return this.latestBriefingItems().find((item) => item.number === number) ?? null;
	}

	setVerdict(runId: string, number: number, verdict: Verdict): void {
		this.sql`UPDATE briefing_items SET verdict = ${verdict} WHERE run_id = ${runId} AND number = ${number}`;
	}

	/** Every briefing item since a time, newest first: sources and verdicts for channel tallies. */
	briefingItemsSince(sinceMs: number): StoredBriefingItem[] {
		return this.sql<{ run_id: string; item_json: string; verdict: string | null; created_at: number }>`
			SELECT run_id, item_json, verdict, created_at FROM briefing_items
			WHERE created_at >= ${sinceMs} ORDER BY created_at DESC, number
		`.map((row) => this.hydrate(row));
	}

	/** What recent briefings said, so the editor reports changes rather than repeats. */
	recentBriefingItems(sinceMs: number, limit = 40): Array<{ section: string; text: string; createdAt: number }> {
		return this.sql<{ section: string; text: string; created_at: number }>`
			SELECT section, text, created_at FROM briefing_items
			WHERE created_at >= ${sinceMs} ORDER BY created_at DESC, number LIMIT ${limit}
		`.map((r) => ({ section: r.section, text: r.text, createdAt: r.created_at }));
	}

	// ----------------------------------------------------- briefed threads

	markBriefed(threads: Array<{ key: string; latestTs: string; headline: string }>, now = Date.now()): void {
		for (const t of threads) {
			this.sql`
				INSERT INTO briefed_threads (key, latest_ts, headline, briefed_at)
				VALUES (${t.key}, ${t.latestTs}, ${t.headline}, ${now})
				ON CONFLICT(key) DO UPDATE SET
					latest_ts = excluded.latest_ts,
					headline = excluded.headline,
					briefed_at = excluded.briefed_at
			`;
		}
	}

	/** Newest message ts a thread had when it was last briefed, in epoch seconds. */
	briefedLatest(key: string): number | undefined {
		const row = this.sql<{ latest_ts: string }>`
			SELECT latest_ts FROM briefed_threads WHERE key = ${key} LIMIT 1
		`[0];
		return row ? Number(row.latest_ts) : undefined;
	}

	/** Maintenance: forget what has been briefed, so conversations can resurface. */
	clearBriefed(): void {
		this.sql`DELETE FROM briefed_threads`;
	}

	// --------------------------------------------------------- preferences

	preferenceProfile(): PreferenceProfile {
		const row = this.sql<{ profile_json: string }>`
			SELECT profile_json FROM preferences WHERE id = 'default' LIMIT 1
		`[0];
		if (!row) return structuredClone(DEFAULT_PROFILE);
		try {
			return { ...structuredClone(DEFAULT_PROFILE), ...(JSON.parse(row.profile_json) as PreferenceProfile) };
		} catch {
			return structuredClone(DEFAULT_PROFILE);
		}
	}

	savePreferenceProfile(profile: PreferenceProfile, now = Date.now()): void {
		this.sql`
			INSERT INTO preferences (id, profile_json, updated_at) VALUES ('default', ${JSON.stringify(profile)}, ${now})
			ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at
		`;
	}

	// ------------------------------------------------------- topic signals

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
		const day = 86_400_000;
		this.sql`DELETE FROM sent_ledger WHERE created_at < ${now - SENT_LEDGER_TTL_DAYS * day}`;
		this.sql`DELETE FROM briefed_threads WHERE briefed_at < ${now - BRIEFED_THREAD_TTL_DAYS * day}`;
		this.sql`DELETE FROM briefing_items WHERE created_at < ${now - BRIEFING_ITEM_TTL_DAYS * day}`;
	}
}
