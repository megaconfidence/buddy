/**
 * Failure handling and self-healing, as pure decisions.
 *
 * In October the Slack connector went down and the agent stayed silent for
 * eight weekdays: every briefing failed into the run ledger, nothing reached
 * the owner, and the MCP registration sat in `authenticating` forever. The
 * rules here make an outage visible, repair the connection with backoff, and
 * catch up once the cause clears.
 */

/** A transitional connection state lasting longer than this is stuck. */
export const STUCK_AFTER_MS = 2 * 60_000;
/** Reconnect attempts back off to at most this interval during an outage. */
export const MAX_RECONNECT_DELAY_MS = 15 * 60_000;
/** Delayed retries of a failed briefing, after the immediate ones. */
export const RETRY_DELAYS_SECONDS = [30 * 60, 2 * 3_600];

/**
 * Whether the Slack connection needs a fresh registration.
 *
 * The gateway authenticates with a bearer header, so `authenticating` means
 * it answered 401 and the SDK is waiting for an OAuth callback that will
 * never come. `connecting`, `connected` and `discovering` are normal on the
 * way to `ready`, and only count as stuck once they have lasted too long.
 */
export function isConnectionStuck(state: string | undefined, downSinceMs: number | null, nowMs: number): boolean {
	if (state === "ready") return false;
	if (state === undefined || state === "failed" || state === "authenticating") return true;
	return downSinceMs !== null && nowMs - downSinceMs > STUCK_AFTER_MS;
}

/** 1, 2, 4, 8, then every 15 minutes: prompt after a blip, quiet during a long outage. */
export function reconnectDelayMs(attempts: number): number {
	if (attempts <= 0) return 0;
	return Math.min(MAX_RECONNECT_DELAY_MS, 60_000 * 2 ** (attempts - 1));
}

/** Seconds until the next delayed retry, or null once they are used up. */
export function nextRetryDelaySeconds(retries: number): number | null {
	return RETRY_DELAYS_SECONDS[retries] ?? null;
}

export type FailureKind = "connection" | "rate_limit" | "model" | "other";

/** A short, owner-facing reason. Never the raw error: it can carry tool output. */
export function describeFailure(error: unknown): { kind: FailureKind; reason: string } {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	if (/not connected|connector_connection_unavailable|\b401\b|unauthori[sz]ed|authenticating/i.test(text)) {
		return { kind: "connection", reason: "Slack couldn't be reached" };
	}
	if (/\b429\b|too many requests|rate.?limit/i.test(text)) {
		return { kind: "rate_limit", reason: "the API was rate limiting" };
	}
	if (/AI_|No(?:Object|Output)Generated|TypeValidation|JSONParse/.test(text)) {
		return { kind: "model", reason: "the model call failed" };
	}
	return { kind: "other", reason: "something unexpected went wrong" };
}

/** A briefing that did not go out, kept until a later run covers its window. */
export type MissedBriefing = {
	/** Start of the window it should have covered, epoch ms. */
	since: number;
	/** When briefings first stopped going out, epoch ms. */
	firstFailedAt: number;
	reason: string;
	/** Delayed retries already scheduled. */
	retries: number;
	/** Whether the owner has been told. False while Slack itself is down. */
	notified: boolean;
};

/**
 * Fold a new failure into the record. The earliest window and first failure
 * time are kept, so one catch-up covers every missed day; the reason is the
 * latest, since that is what still needs fixing.
 */
export function recordMissed(existing: MissedBriefing | null, failure: { since: number; at: number; reason: string }): MissedBriefing {
	if (!existing) return { since: failure.since, firstFailedAt: failure.at, reason: failure.reason, retries: 0, notified: false };
	return {
		...existing,
		since: Math.min(existing.since, failure.since),
		firstFailedAt: Math.min(existing.firstFailedAt, failure.at),
		reason: failure.reason,
	};
}

export function parseMissed(raw: string | null): MissedBriefing | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<MissedBriefing>;
		if (typeof value.since !== "number" || typeof value.firstFailedAt !== "number") return null;
		return {
			since: value.since,
			firstFailedAt: value.firstFailedAt,
			reason: typeof value.reason === "string" ? value.reason : "something unexpected went wrong",
			retries: typeof value.retries === "number" ? value.retries : 0,
			notified: value.notified === true,
		};
	} catch {
		return null;
	}
}
