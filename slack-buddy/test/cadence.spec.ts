import { describe, expect, it } from "vitest";
import {
	BURST_SECONDS,
	IDLE_SECONDS,
	WORKING_SECONDS,
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
