/**
 * Adaptive poll cadence.
 *
 * There is no push path from Slack without a Slack app, so responsiveness is
 * bought with poll frequency. A flat 10s poll costs ~8,640 gateway calls a day;
 * following the owner's working hours costs roughly 950 and is more responsive
 * during an actual conversation.
 */

export const BURST_SECONDS = 10;
export const WORKING_SECONDS = 60;
export const IDLE_SECONDS = 900;

/** How long a burst lasts after the owner's last message. */
export const ACTIVITY_WINDOW_MS = 10 * 60_000;
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
export function nextPollDelaySeconds(opts: {
	now: Date;
	timeZone: string;
	lastActivityAt: number | null;
	lastDigestAt: number | null;
}): number {
	const ms = opts.now.getTime();

	if (opts.lastActivityAt !== null && ms - opts.lastActivityAt < ACTIVITY_WINDOW_MS) {
		return BURST_SECONDS;
	}
	if (opts.lastDigestAt !== null && ms - opts.lastDigestAt < DIGEST_WINDOW_MS) {
		return BURST_SECONDS;
	}
	return isWorkingHours(opts.now, opts.timeZone) ? WORKING_SECONDS : IDLE_SECONDS;
}
