/**
 * Adaptive poll cadence.
 *
 * There is no push path from Slack without a Slack app, so responsiveness is
 * bought with poll frequency. A flat 10s poll costs ~8,640 gateway calls a day;
 * following the owner's working hours costs roughly 950 and is more responsive
 * during an actual conversation.
 */

/**
 * Intervals.
 *
 * A single poll costs ~1.6s (mostly the gateway round trip) and the full
 * reply pipeline — read, react, model turn, send — is ~7s. Reply latency is
 * therefore `poll wait + ~7s`, and below a 2s interval polls would overlap
 * while saving under a second. The model turn is the floor, not the cadence.
 *
 * Budget at these settings is roughly 5,600 requests/day against a free-plan
 * allowance of 100,000, and about 8% of the monthly Durable Object duration.
 * The practical ceiling is the gateway's own rate limiting, not Cloudflare.
 */
export const BURST_SECONDS = 5;
export const WORKING_SECONDS = 15;
export const IDLE_SECONDS = 60;

/**
 * Interval used while the upstream API is rate limiting us.
 *
 * The gateway and the model share one Mistral API key, so a burst of polling
 * can starve the model calls that actually answer the owner. Backing off the
 * cheap, frequent thing protects the expensive, important one.
 */
export const RATE_LIMITED_SECONDS = 120;

/**
 * How long a burst lasts after the owner's last message.
 *
 * Generous on purpose: a conversation has gaps while you read a reply and
 * type the next message, and dropping out of burst mid-exchange is exactly
 * when the lag is most noticeable.
 */
export const ACTIVITY_WINDOW_MS = 15 * 60_000;
/** How long a burst lasts after the digest lands, when a reply is likely. */
export const DIGEST_WINDOW_MS = 20 * 60_000;

const WORKING_START_HOUR = 8;
const WORKING_END_HOUR = 19;

type LocalTime = { hour: number; weekday: string };

function localTime(now: Date, timeZone: string): LocalTime {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		hour12: false,
		weekday: "short",
	}).formatToParts(now);

	const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
	const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
	return { hour, weekday };
}

export function isWorkingHours(now: Date, timeZone: string): boolean {
	const { hour, weekday } = localTime(now, timeZone);
	if (weekday === "Sat" || weekday === "Sun") return false;
	return hour >= WORKING_START_HOUR && hour < WORKING_END_HOUR;
}

/**
 * Seconds until the next poll.
 *
 * Bursts win over the calendar: a conversation at 23:00 stays responsive.
 */
export type PendingSchedule = { id?: string; callback?: string; time?: number };

/**
 * Decide whether to arm a new poll, and which existing rows to cancel.
 *
 * Two failure modes this has to avoid at once:
 *
 * 1. The 15-minute cron also re-arms. Cancelling unconditionally let each tick
 *    push the next poll a further interval away, deferring it indefinitely.
 * 2. `pollInbox` re-arms from its own `finally`, while its schedule row still
 *    exists. Treating that row as "a poll already scheduled sooner" means no
 *    new poll is armed and the chain dies after exactly one tick.
 *
 * The distinction is liveness: a row at or before now is either the alarm
 * currently executing or one that was missed. Neither will fire again, so
 * neither may block re-arming.
 */
export function choosePollSchedule(opts: {
	nowSec: number;
	delaySeconds: number;
	pending: PendingSchedule[];
}): { arm: boolean; cancelIds: string[] } {
	const target = opts.nowSec + opts.delaySeconds;
	const polls = opts.pending.filter(
		(s): s is PendingSchedule & { id: string } =>
			s.callback === "pollInbox" && typeof s.id === "string",
	);

	const live = polls.filter(
		(s) => typeof s.time === "number" && s.time > opts.nowSec,
	);
	const soonest = live.reduce<number | undefined>(
		(min, s) => (min === undefined || (s.time as number) < min ? s.time : min),
		undefined,
	);

	if (soonest !== undefined && soonest <= target) {
		return {
			arm: false,
			cancelIds: polls.filter((s) => s.time !== soonest).map((s) => s.id),
		};
	}

	return { arm: true, cancelIds: polls.map((s) => s.id) };
}

export function nextPollDelaySeconds(opts: {
	now: Date;
	timeZone: string;
	lastActivityAt: number | null;
	lastDigestAt: number | null;
	rateLimitedUntil?: number | null;
}): number {
	const ms = opts.now.getTime();

	// Backoff outranks every burst rule. Staying responsive is pointless if
	// the replies themselves are being rejected upstream.
	if (opts.rateLimitedUntil != null && ms < opts.rateLimitedUntil) {
		return RATE_LIMITED_SECONDS;
	}

	if (opts.lastActivityAt !== null && ms - opts.lastActivityAt < ACTIVITY_WINDOW_MS) {
		return BURST_SECONDS;
	}
	if (opts.lastDigestAt !== null && ms - opts.lastDigestAt < DIGEST_WINDOW_MS) {
		return BURST_SECONDS;
	}
	return isWorkingHours(opts.now, opts.timeZone) ? WORKING_SECONDS : IDLE_SECONDS;
}
