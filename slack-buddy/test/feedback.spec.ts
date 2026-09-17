import { describe, expect, it } from "vitest";
import {
	DEMOTE_AT,
	PROMOTE_AT,
	classifyReactions,
	watchlistAction,
} from "../src/feedback";
import { parseReactions } from "../src/slack/parse";

const OWNER = "U0BUM44636U";

// Verbatim gateway output, captured 2026-09-17.
const REAL = "Reactions on message:\n\n:+1: × 1 — confidence (U0BUM44636U)";
const NONE = "No reactions found on this message.";

describe("parseReactions", () => {
	it("parses the live reaction format", () => {
		expect(parseReactions(REAL)).toEqual([
			{ emoji: "+1", count: 1, userIds: [OWNER] },
		]);
	});

	it("returns nothing for the empty case", () => {
		expect(parseReactions(NONE)).toEqual([]);
	});

	it("handles several reactors on one emoji", () => {
		const text =
			"Reactions on message:\n\n:fire: × 2 — confidence (U0BUM44636U), Ada (U999)";
		expect(parseReactions(text)[0]).toEqual({
			emoji: "fire",
			count: 2,
			userIds: [OWNER, "U999"],
		});
	});
});

describe("classifyReactions", () => {
	it("reads an alias-canonicalised thumbsup as useful", () => {
		// The reaction was added as `thumbsup`; Slack stores it as `+1`.
		// Matching on the alias would silently never fire.
		expect(classifyReactions(parseReactions(REAL), OWNER)).toBe("useful");
	});

	it("reads a thumbsdown as noise", () => {
		const reactions = [{ emoji: "-1", count: 1, userIds: [OWNER] }];
		expect(classifyReactions(reactions, OWNER)).toBe("noise");
	});

	it("returns none when there are no reactions", () => {
		expect(classifyReactions([], OWNER)).toBe("none");
	});

	it("ignores reactions from anyone but the owner", () => {
		const reactions = [{ emoji: "+1", count: 1, userIds: ["U999"] }];
		expect(classifyReactions(reactions, OWNER)).toBe("none");
	});

	it("lets an explicit negative outrank a positive", () => {
		const reactions = [
			{ emoji: "+1", count: 1, userIds: [OWNER] },
			{ emoji: "-1", count: 1, userIds: [OWNER] },
		];
		expect(classifyReactions(reactions, OWNER)).toBe("noise");
	});

	it("ignores the eyes ack the agent adds to owner messages", () => {
		const reactions = [{ emoji: "eyes", count: 1, userIds: [OWNER] }];
		expect(classifyReactions(reactions, OWNER)).toBe("none");
	});
});

describe("watchlistAction", () => {
	it("holds until there is real evidence", () => {
		expect(watchlistAction(0, 0)).toBe("hold");
		expect(watchlistAction(1, 0)).toBe("hold");
	});

	it("promotes once positives reach the threshold", () => {
		expect(watchlistAction(PROMOTE_AT, 0)).toBe("promote");
	});

	it("demotes once negatives reach the threshold", () => {
		expect(watchlistAction(0, Math.abs(DEMOTE_AT))).toBe("demote");
	});

	it("uses the net score, so a mixed term stays put", () => {
		expect(watchlistAction(3, 3)).toBe("hold");
	});
});
