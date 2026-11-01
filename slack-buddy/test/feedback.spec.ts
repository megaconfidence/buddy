import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROFILE,
	DEMOTE_AT,
	PROMOTE_AT,
	SUGGEST_AFTER_BRIEFINGS,
	SUGGEST_AFTER_USEFUL,
	applyVerdict,
	exampleOf,
	suggestFocusChannel,
	tallyChannels,
	termDirection,
	watchlistAction,
} from "../src/feedback";

const idea = { section: "content_idea" as const, text: "Ship a coding agent with Vibe 2.0", format: "video" as const };
const news = { section: "whats_new" as const, text: "Codestral 3 is live", format: null };

describe("applyVerdict", () => {
	it("learns from a useful item, including its content format", () => {
		const profile = applyVerdict(DEFAULT_PROFILE, idea, "useful");
		expect(profile.positiveExamples).toEqual([exampleOf(idea)]);
		expect(profile.preferredFormats).toEqual(["video"]);
		expect(profile.version).toBe(DEFAULT_PROFILE.version + 1);
	});

	it("learns from noise", () => {
		const profile = applyVerdict(DEFAULT_PROFILE, news, "noise");
		expect(profile.negativeExamples).toEqual(["What's new: Codestral 3 is live"]);
		expect(profile.positiveExamples).toEqual([]);
	});

	it("lets a later verdict replace an earlier one", () => {
		const changed = applyVerdict(applyVerdict(DEFAULT_PROFILE, news, "useful"), news, "noise");
		expect(changed.positiveExamples).toEqual([]);
		expect(changed.negativeExamples).toHaveLength(1);
	});

	it("records nothing for handled, which says nothing about relevance", () => {
		expect(applyVerdict(DEFAULT_PROFILE, news, "handled")).toBe(DEFAULT_PROFILE);
	});

	it("keeps the profile bounded", () => {
		let profile = DEFAULT_PROFILE;
		for (let i = 0; i < 50; i++) profile = applyVerdict(profile, { ...news, text: `Item ${i}` }, "useful");
		expect(profile.positiveExamples).toHaveLength(30);
		expect(profile.positiveExamples.at(-1)).toContain("Item 49");
	});

	it("does not mutate the profile it was given", () => {
		applyVerdict(DEFAULT_PROFILE, idea, "useful");
		expect(DEFAULT_PROFILE.positiveExamples).toEqual([]);
	});
});

describe("tallyChannels", () => {
	const src = (channelId: string, channelName: string | null = channelId.toLowerCase()) => ({ channelId, channelName });

	it("counts the briefings a channel fed, once per briefing, and the verdicts on its items", () => {
		const tallies = tallyChannels([
			{ runId: "r1", sources: [src("C1"), src("C1")], verdict: "useful" },
			{ runId: "r1", sources: [src("C1")], verdict: null },
			{ runId: "r2", sources: [src("C1"), src("C2")], verdict: "noise" },
		]);
		expect(tallies.find((t) => t.channelId === "C1")).toEqual({ channelId: "C1", name: "c1", briefings: 2, useful: 1, noise: 1 });
		expect(tallies.find((t) => t.channelId === "C2")).toEqual({ channelId: "C2", name: "c2", briefings: 1, useful: 0, noise: 1 });
	});
});

describe("suggestFocusChannel", () => {
	const tally = (channelId: string, briefings: number, useful = 0, noise = 0) => ({
		channelId,
		name: channelId.toLowerCase(),
		briefings,
		useful,
		noise,
	});
	const none = new Set<string>();

	it("suggests a channel that keeps feeding briefings", () => {
		expect(suggestFocusChannel([tally("C1", SUGGEST_AFTER_BRIEFINGS)], { exclude: none, full: false })?.channelId).toBe("C1");
	});

	it("suggests a channel whose items were useful, even if it fed few briefings", () => {
		expect(suggestFocusChannel([tally("C1", 1, SUGGEST_AFTER_USEFUL)], { exclude: none, full: false })?.channelId).toBe("C1");
	});

	it("needs evidence before suggesting anything", () => {
		expect(suggestFocusChannel([tally("C1", SUGGEST_AFTER_BRIEFINGS - 1)], { exclude: none, full: false })).toBeNull();
	});

	it("never suggests a channel mostly marked as noise", () => {
		expect(suggestFocusChannel([tally("C1", 5, 1, 2)], { exclude: none, full: false })).toBeNull();
	});

	it("skips focus channels and recent suggestions, and stops when the list is full", () => {
		const tallies = [tally("C1", 6), tally("C2", 4)];
		expect(suggestFocusChannel(tallies, { exclude: new Set(["C1"]), full: false })?.channelId).toBe("C2");
		expect(suggestFocusChannel(tallies, { exclude: none, full: true })).toBeNull();
	});

	it("prefers what the owner found useful over sheer volume", () => {
		const best = suggestFocusChannel([tally("C1", 6), tally("C2", 3, 3)], { exclude: none, full: false });
		expect(best?.channelId).toBe("C2");
	});

	it("only suggests a named channel the owner can refer to", () => {
		expect(suggestFocusChannel([{ ...tally("C1", 6), name: null }], { exclude: none, full: false })).toBeNull();
		expect(suggestFocusChannel([tally("D1", 6)], { exclude: none, full: false })).toBeNull();
	});
});

describe("termDirection", () => {
	it("scores terms up for useful and down for noise, and leaves handled alone", () => {
		expect(termDirection("useful")).toBe("useful");
		expect(termDirection("noise")).toBe("noise");
		expect(termDirection("handled")).toBeNull();
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
