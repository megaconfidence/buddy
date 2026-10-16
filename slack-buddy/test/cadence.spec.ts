import { describe, expect, it } from "vitest";
import {
	BURST_SECONDS,
	IDLE_SECONDS,
	RATE_LIMITED_SECONDS,
	WORKING_SECONDS,
	choosePollSchedule,
	isWorkingHours,
	nextPollDelaySeconds,
} from "../src/cadence";

const TZ = "Europe/London";

// 2026-09-17 is a Thursday. September is BST, so UTC+1.
const thursday = (utcHour: number) =>
	new Date(Date.UTC(2026, 8, 17, utcHour, 0, 0));
const saturday = (utcHour: number) =>
	new Date(Date.UTC(2026, 8, 19, utcHour, 0, 0));

describe("isWorkingHours", () => {
	it("treats a weekday mid-morning as working hours", () => {
		expect(isWorkingHours(thursday(10), TZ)).toBe(true);
	});

	it("applies the owner's timezone, not UTC", () => {
		// 07:30 UTC is 08:30 BST, inside working hours. Reading this as UTC
		// would place it outside and slow the poll during the digest window.
		expect(isWorkingHours(new Date(Date.UTC(2026, 8, 17, 7, 30)), TZ)).toBe(true);
	});

	it("excludes the small hours", () => {
		expect(isWorkingHours(thursday(3), TZ)).toBe(false);
	});

	it("excludes weekends", () => {
		expect(isWorkingHours(saturday(10), TZ)).toBe(false);
	});
});

describe("nextPollDelaySeconds", () => {
	const base = { timeZone: TZ, lastActivityAt: null, lastDigestAt: null };

	it("polls every minute during working hours", () => {
		expect(nextPollDelaySeconds({ ...base, now: thursday(10) })).toBe(
			WORKING_SECONDS,
		);
	});

	it("backs off overnight", () => {
		expect(nextPollDelaySeconds({ ...base, now: thursday(3) })).toBe(IDLE_SECONDS);
	});

	it("bursts just after the owner speaks", () => {
		const now = thursday(10);
		expect(
			nextPollDelaySeconds({
				...base,
				now,
				lastActivityAt: now.getTime() - 60_000,
			}),
		).toBe(BURST_SECONDS);
	});

	it("stops bursting once the activity window lapses", () => {
		const now = thursday(10);
		expect(
			nextPollDelaySeconds({
				...base,
				now,
				lastActivityAt: now.getTime() - 20 * 60_000,
			}),
		).toBe(WORKING_SECONDS);
	});

	it("bursts after the digest, when a reply is likely", () => {
		const now = thursday(7);
		expect(
			nextPollDelaySeconds({ ...base, now, lastDigestAt: now.getTime() - 60_000 }),
		).toBe(BURST_SECONDS);
	});

	it("lets a late-night conversation override the idle calendar", () => {
		const now = thursday(23);
		expect(
			nextPollDelaySeconds({
				...base,
				now,
				lastActivityAt: now.getTime() - 30_000,
			}),
		).toBe(BURST_SECONDS);
	});
});

describe("choosePollSchedule", () => {
	const NOW = 1_000_000;
	const poll = (id: string, time: number) => ({
		id,
		callback: "pollInbox",
		time,
	});

	it("arms when nothing is pending", () => {
		const d = choosePollSchedule({ nowSec: NOW, delaySeconds: 2, pending: [] });
		expect(d).toEqual({ arm: true, cancelIds: [] });
	});

	it("re-arms when the only row is the alarm currently firing", () => {
		// pollInbox re-arms from its own `finally`, while its row still exists
		// at or before now. Treating that as a pending poll killed the chain
		// after exactly one tick, so the agent polled only when externally
		// poked. This is the regression test for that.
		const d = choosePollSchedule({
			nowSec: NOW,
			delaySeconds: 2,
			pending: [poll("current", NOW)],
		});
		expect(d.arm).toBe(true);
		expect(d.cancelIds).toEqual(["current"]);
	});

	it("re-arms past a missed alarm", () => {
		const d = choosePollSchedule({
			nowSec: NOW,
			delaySeconds: 2,
			pending: [poll("stale", NOW - 600)],
		});
		expect(d.arm).toBe(true);
	});

	it("keeps a live poll that fires sooner, so the cron cannot defer it", () => {
		const d = choosePollSchedule({
			nowSec: NOW,
			delaySeconds: 900,
			pending: [poll("soon", NOW + 5)],
		});
		expect(d).toEqual({ arm: false, cancelIds: [] });
	});

	it("replaces a live poll that fires later than the new target", () => {
		const d = choosePollSchedule({
			nowSec: NOW,
			delaySeconds: 2,
			pending: [poll("later", NOW + 600)],
		});
		expect(d.arm).toBe(true);
		expect(d.cancelIds).toEqual(["later"]);
	});

	it("collapses duplicates down to the soonest live row", () => {
		const d = choosePollSchedule({
			nowSec: NOW,
			delaySeconds: 900,
			pending: [poll("a", NOW + 30), poll("b", NOW + 5), poll("c", NOW + 60)],
		});
		expect(d.arm).toBe(false);
		expect(d.cancelIds.sort()).toEqual(["a", "c"]);
	});

	it("ignores schedules belonging to other callbacks", () => {
		const d = choosePollSchedule({
			nowSec: NOW,
			delaySeconds: 2,
			pending: [{ id: "digest", callback: "_runDeclaredScheduledTask", time: NOW + 5 }],
		});
		expect(d).toEqual({ arm: true, cancelIds: [] });
	});
});

describe("rate-limit backoff", () => {
	const base = { timeZone: TZ, lastActivityAt: null, lastDigestAt: null };

	it("backs off while rate limited, overriding an active burst", () => {
		// The gateway and the model share one API key, so bursting into a 429
		// starves the very calls that answer the owner. Backoff must win.
		const now = thursday(10);
		expect(
			nextPollDelaySeconds({
				...base,
				now,
				lastActivityAt: now.getTime() - 30_000,
				rateLimitedUntil: now.getTime() + 60_000,
			}),
		).toBe(RATE_LIMITED_SECONDS);
	});

	it("resumes normal cadence once the backoff expires", () => {
		const now = thursday(10);
		expect(
			nextPollDelaySeconds({
				...base,
				now,
				rateLimitedUntil: now.getTime() - 1,
			}),
		).toBe(WORKING_SECONDS);
	});

	it("is unaffected when no backoff is recorded", () => {
		const now = thursday(10);
		expect(
			nextPollDelaySeconds({ ...base, now, rateLimitedUntil: null }),
		).toBe(WORKING_SECONDS);
	});
});
