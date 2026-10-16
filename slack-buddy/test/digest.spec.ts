import { describe, expect, it } from "vitest";
import {
	SEARCH_BUDGET,
	buildQueryPlan,
	isEngaged,
	lastOwnerPosts,
	runDigest,
	threadKey,
} from "../src/digest";
import type { SlackClient } from "../src/slack/client";
import type { SearchHit } from "../src/slack/parse";
import type { Store } from "../src/state";

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

const CHANNEL = "C08LQA773DW";
const THREAD_ROOT = "1792143547.341719";

/** Search hits as the gateway renders them; thread membership lives in the permalink. */
function hit(ts: string, authorId: string, threadTs?: string): SearchHit {
	const query = threadTs ? `?thread_ts=${threadTs}&cid=${CHANNEL}` : "";
	return {
		ts,
		channelId: CHANNEL,
		channelName: "devrel",
		authorId,
		authorName: null,
		time: null,
		permalink: `https://mistralai.slack.com/archives/${CHANNEL}/p${ts.replace(".", "")}${query}`,
		text: "text",
	};
}

describe("threadKey", () => {
	it("uses the permalink's thread_ts for a reply", () => {
		expect(threadKey(hit("1792143734.978529", "U1", THREAD_ROOT))).toBe(
			`${CHANNEL}:${THREAD_ROOT}`,
		);
	});

	it("puts a thread parent in its own thread", () => {
		expect(threadKey(hit(THREAD_ROOT, "U1", THREAD_ROOT))).toBe(
			`${CHANNEL}:${THREAD_ROOT}`,
		);
	});

	it("treats a message that starts no thread as its own root", () => {
		expect(threadKey(hit("1792000000.000001", "U1"))).toBe(
			`${CHANNEL}:1792000000.000001`,
		);
	});
});

describe("isEngaged", () => {
	const ownerPosts = lastOwnerPosts(
		[
			hit("1792143600.000000", OWNER, THREAD_ROOT),
			hit("1792143700.000000", OWNER, THREAD_ROOT),
		],
		OWNER,
	);

	it("drops the owner's own messages", () => {
		expect(isEngaged(hit("1792000000.000001", OWNER), OWNER, new Map())).toBe(true);
	});

	it("drops the parent of a thread the owner replied in", () => {
		expect(isEngaged(hit(THREAD_ROOT, "U1", THREAD_ROOT), OWNER, ownerPosts)).toBe(
			true,
		);
	});

	it("drops a reply the owner posted after", () => {
		expect(
			isEngaged(hit("1792143650.000000", "U1", THREAD_ROOT), OWNER, ownerPosts),
		).toBe(true);
	});

	it("keeps a reply that arrived after the owner's last post", () => {
		// Someone answering the owner is exactly what the briefing must not hide.
		expect(
			isEngaged(hit("1792143800.000000", "U1", THREAD_ROOT), OWNER, ownerPosts),
		).toBe(false);
	});

	it("keeps messages in threads the owner never posted in", () => {
		expect(
			isEngaged(hit("1792143650.000000", "U1", "1792100000.000000"), OWNER, ownerPosts),
		).toBe(false);
	});

	it("ignores posts by anyone else when building the owner's history", () => {
		const posts = lastOwnerPosts([hit("1792143700.000000", "U1", THREAD_ROOT)], OWNER);
		expect(posts.size).toBe(0);
	});
});

describe("runDigest engagement filter", () => {
	function fakes(opts: { ownerSearch: () => Promise<SearchHit[]>; hits: SearchHit[] }) {
		const calls: Array<{ keywords: string[]; filters?: string }> = [];
		const client = {
			searchJoined: async (args: { keywords: string[]; filters?: string }) => {
				calls.push(args);
				return args.filters ? opts.ownerSearch() : opts.hits;
			},
		} as unknown as SlackClient;
		const store = {
			activeTopics: () => [],
			signals: () => [],
			hasSeen: () => false,
			isSent: () => false,
			markSeen: () => {},
		} as unknown as Store;
		return { client, store, calls };
	}

	const since = new Date(now.getTime() - 18 * 3_600_000);

	it("searches the owner's posts once, over the same window", async () => {
		const { client, store, calls } = fakes({
			ownerSearch: async () => [],
			hits: [],
		});
		await runDigest({ client, store, model: null as never, ownerId: OWNER, since, now });
		const ownerCalls = calls.filter((c) => c.filters);
		expect(ownerCalls).toHaveLength(1);
		expect(ownerCalls[0]).toMatchObject({
			keywords: [],
			filters: `from:<@${OWNER}>`,
			after: Math.floor(since.getTime() / 1000).toString(),
		});
	});

	it("drops engaged hits before triage and counts them", async () => {
		const { client, store } = fakes({
			ownerSearch: async () => [hit("1792143700.000000", OWNER, THREAD_ROOT)],
			hits: [hit("1792000000.000001", OWNER), hit(THREAD_ROOT, "U1", THREAD_ROOT)],
		});
		// Every hit is engaged, so the run ends before the model is called.
		const result = await runDigest({
			client,
			store,
			model: null as never,
			ownerId: OWNER,
			since,
			now,
		});
		expect(result.status).toBe("empty");
		expect(result.stats).toMatchObject({ retrieved: 2, engaged: 2, candidates: 0 });
	});

	it("still drops the owner's own messages when the owner search fails", async () => {
		const { client, store } = fakes({
			ownerSearch: async () => {
				throw new Error("gateway down");
			},
			hits: [hit("1792000000.000001", OWNER)],
		});
		const result = await runDigest({
			client,
			store,
			model: null as never,
			ownerId: OWNER,
			since,
			now,
		});
		expect(result.stats).toMatchObject({ retrieved: 1, engaged: 1, candidates: 0 });
	});
});
