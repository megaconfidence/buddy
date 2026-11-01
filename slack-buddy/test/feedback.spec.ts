import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROFILE,
	DEMOTE_AT,
	PROMOTE_AT,
	applyVerdict,
	exampleOf,
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
