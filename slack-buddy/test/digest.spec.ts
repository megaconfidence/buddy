import { describe, expect, it } from "vitest";
import { SEARCH_BUDGET, buildQueryPlan } from "../src/digest";

const OWNER = "U0BUM44636U";
const now = new Date(Date.UTC(2026, 8, 17, 7, 30));

describe("buildQueryPlan", () => {
	it("always leads with the owner mention query", () => {
		const plan = buildQueryPlan({ ownerId: OWNER, topics: [], now });
		expect(plan[0]).toEqual(["<@U0BUM44636U>"]);
	});

	it("uses the mention token, not the display name", () => {
		// `filters: "to:@user"` returns zero hits silently, and this owner's
		// display name is also an ordinary English word. The raw mention token
		// is the only form verified to work.
		const [mention] = buildQueryPlan({ ownerId: OWNER, topics: [], now });
		expect(mention[0]).toMatch(/^<@U[A-Z0-9]+>$/);
		expect(mention[0]).not.toMatch(/confidence/i);
	});

	it("respects the search budget", () => {
		const plan = buildQueryPlan({
			ownerId: OWNER,
			topics: ["OCR", "Vibe", "Le Chat", "Codestral", "Magistral", "Voxtral"],
			now,
		});
		expect(plan.length).toBeLessThanOrEqual(SEARCH_BUDGET);
	});

	it("caps watchlist topics so signal queries still get slots", () => {
		const plan = buildQueryPlan({
			ownerId: OWNER,
			topics: ["a", "b", "c", "d", "e", "f", "g"],
			now,
		});
		const topicQueries = plan.filter(([k]) => k.length === 1);
		expect(topicQueries.length).toBeLessThanOrEqual(4);
	});

	it("keeps every query to a single term, since keywords are AND-ed", () => {
		const plan = buildQueryPlan({ ownerId: OWNER, topics: ["OCR"], now });
		for (const query of plan) expect(query).toHaveLength(1);
	});

	it("rotates signal terms across days so coverage accumulates", () => {
		const today = buildQueryPlan({ ownerId: OWNER, topics: [], now });
		const nextWeek = buildQueryPlan({
			ownerId: OWNER,
			topics: [],
			now: new Date(now.getTime() + 3 * 86_400_000),
		});
		expect(today.flat()).not.toEqual(nextWeek.flat());
	});

	it("is stable within the same day", () => {
		const a = buildQueryPlan({ ownerId: OWNER, topics: ["OCR"], now });
		const b = buildQueryPlan({
			ownerId: OWNER,
			topics: ["OCR"],
			now: new Date(now.getTime() + 60_000),
		});
		expect(a).toEqual(b);
	});
});

describe("buildQueryPlan with reaction feedback", () => {
	it("promotes a term the owner keeps reacting well to", () => {
		const plan = buildQueryPlan({
			ownerId: OWNER,
			topics: [],
			now,
			signals: [{ term: "roadmap", positive: 3, negative: 0 }],
		});
		expect(plan.flat()).toContain("roadmap");
		// Promoted into a topic slot, so it leads the signal rotation.
		expect(plan.findIndex((q) => q[0] === "roadmap")).toBe(1);
	});

	it("drops a term the owner marked as noise", () => {
		const plan = buildQueryPlan({
			ownerId: OWNER,
			topics: [],
			now,
			signals: [{ term: "webinar", positive: 0, negative: 3 }],
		});
		expect(plan.flat()).not.toContain("webinar");
	});

	it("drops a demoted term even when it was explicitly on the watchlist", () => {
		const plan = buildQueryPlan({
			ownerId: OWNER,
			topics: ["Vibe"],
			now,
			signals: [{ term: "Vibe", positive: 0, negative: 4 }],
		});
		expect(plan.flat()).not.toContain("Vibe");
	});

	it("ignores weak evidence", () => {
		const withSignal = buildQueryPlan({
			ownerId: OWNER,
			topics: [],
			now,
			signals: [{ term: "roadmap", positive: 1, negative: 0 }],
		});
		const without = buildQueryPlan({ ownerId: OWNER, topics: [], now });
		expect(withSignal).toEqual(without);
	});

	it("never lets promotion push the plan over budget", () => {
		const plan = buildQueryPlan({
			ownerId: OWNER,
			topics: ["OCR", "Vibe", "Le Chat"],
			now,
			signals: [
				{ term: "roadmap", positive: 5, negative: 0 },
				{ term: "beta", positive: 5, negative: 0 },
				{ term: "demo", positive: 5, negative: 0 },
			],
		});
		expect(plan.length).toBeLessThanOrEqual(SEARCH_BUDGET);
	});

	it("does not duplicate a promoted term already on the watchlist", () => {
		const plan = buildQueryPlan({
			ownerId: OWNER,
			topics: ["OCR"],
			now,
			signals: [{ term: "OCR", positive: 4, negative: 0 }],
		});
		expect(plan.flat().filter((t) => t === "OCR")).toHaveLength(1);
	});
});
