import { describe, expect, it } from "vitest";
import {
	MAX_RECONNECT_DELAY_MS,
	RETRY_DELAYS_SECONDS,
	STUCK_AFTER_MS,
	describeFailure,
	isConnectionStuck,
	nextRetryDelaySeconds,
	parseMissed,
	reconnectDelayMs,
	recordMissed,
} from "../src/recovery";

const NOW = 1_800_000_000_000;

describe("isConnectionStuck", () => {
	it("leaves a ready connection alone", () => {
		expect(isConnectionStuck("ready", NOW - 3_600_000, NOW)).toBe(false);
	});

	it("treats authenticating as dead: the gateway uses a bearer header, so no OAuth callback is coming", () => {
		// Regression: the October outage sat in `authenticating` for eight weekdays.
		expect(isConnectionStuck("authenticating", NOW, NOW)).toBe(true);
	});

	it("treats failed and missing registrations as dead", () => {
		expect(isConnectionStuck("failed", NOW, NOW)).toBe(true);
		expect(isConnectionStuck(undefined, null, NOW)).toBe(true);
	});

	it("waits out the normal handshake states", () => {
		// Reconnecting on sight of these once caused a churn loop that never
		// let discovery finish.
		for (const state of ["connecting", "connected", "discovering"]) {
			expect(isConnectionStuck(state, NOW - 10_000, NOW)).toBe(false);
		}
	});

	it("gives up on a handshake state that has lasted too long", () => {
		expect(isConnectionStuck("connecting", NOW - STUCK_AFTER_MS - 1, NOW)).toBe(true);
	});
});

describe("reconnectDelayMs", () => {
	it("tries at once, then backs off to a 15-minute ceiling", () => {
		expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([
			0,
			60_000,
			120_000,
			240_000,
			480_000,
			MAX_RECONNECT_DELAY_MS,
			MAX_RECONNECT_DELAY_MS,
		]);
	});
});

describe("nextRetryDelaySeconds", () => {
	it("retries after 30 minutes, then 2 hours, then stops", () => {
		expect(nextRetryDelaySeconds(0)).toBe(RETRY_DELAYS_SECONDS[0]);
		expect(nextRetryDelaySeconds(1)).toBe(RETRY_DELAYS_SECONDS[1]);
		expect(nextRetryDelaySeconds(2)).toBeNull();
	});
});

describe("describeFailure", () => {
	it("names a Slack connection failure", () => {
		expect(describeFailure(new Error("Not connected"))).toEqual({ kind: "connection", reason: "Slack couldn't be reached" });
		expect(describeFailure(new Error("HTTP 401 connector_connection_unavailable")).kind).toBe("connection");
	});

	it("names rate limiting", () => {
		expect(describeFailure(new Error("AI_RetryError: 429 Too Many Requests")).kind).toBe("rate_limit");
	});

	it("names a model failure", () => {
		const error = Object.assign(new Error("No object generated: response did not match schema."), { name: "AI_NoObjectGeneratedError" });
		expect(describeFailure(error)).toEqual({ kind: "model", reason: "the model call failed" });
	});

	it("never echoes the raw error, which can carry tool output", () => {
		const { reason } = describeFailure(new Error("slack_read_thread failed: <secret channel content>"));
		expect(reason).toBe("something unexpected went wrong");
	});
});

describe("recordMissed", () => {
	it("starts a record on the first failure", () => {
		expect(recordMissed(null, { since: 100, at: 200, reason: "x" })).toEqual({
			since: 100,
			firstFailedAt: 200,
			reason: "x",
			retries: 0,
			notified: false,
		});
	});

	it("keeps the earliest window, so one catch-up covers every missed day", () => {
		const first = { since: 100, firstFailedAt: 200, reason: "Slack couldn't be reached", retries: 1, notified: true };
		expect(recordMissed(first, { since: 150, at: 900, reason: "the model call failed" })).toEqual({
			since: 100,
			firstFailedAt: 200,
			reason: "the model call failed",
			retries: 1,
			notified: true,
		});
	});
});

describe("parseMissed", () => {
	it("round-trips a record and rejects garbage", () => {
		const record = { since: 1, firstFailedAt: 2, reason: "r", retries: 1, notified: true };
		expect(parseMissed(JSON.stringify(record))).toEqual(record);
		expect(parseMissed(null)).toBeNull();
		expect(parseMissed("{not json")).toBeNull();
		expect(parseMissed(JSON.stringify({ reason: "no times" }))).toBeNull();
	});
});
