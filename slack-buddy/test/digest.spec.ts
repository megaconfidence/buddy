import { describe, expect, it } from "vitest";
import { TEAM_TERMS } from "../src/digest/collect";
import { SEARCH_BUDGET, buildQueryPlan, lastOwnerPosts, runDigest, threadKey, type DigestStore } from "../src/digest";
import { DEFAULT_PROFILE } from "../src/feedback";
import type { SlackClient } from "../src/slack/client";
import type { SearchHit, SlackMessage } from "../src/slack/parse";
import { HOST, NOW, SINCE, hit as hitAt, permalink, scriptedModel, slackMessage, ts } from "./helpers";

const OWNER = "U0BUM44636U";
const now = new Date(Date.UTC(2026, 8, 17, 7, 30));

describe("buildQueryPlan", () => {
	it("always leads with the owner mention query", () => {
		const plan = buildQueryPlan({ ownerId: OWNER, topics: [], now });
		expect(plan[0]).toEqual(["<@U0BUM44636U>"]);
	});

	it("always searches the team terms right after the mention", () => {
		const plan = buildQueryPlan({ ownerId: OWNER, topics: ["OCR", "Vibe"], now });
		expect(plan[1]).toEqual(["devrel"]);
	});

	it("does not spend a topic slot on a team term", () => {
		const plan = buildQueryPlan({ ownerId: OWNER, topics: ["devrel", "OCR"], now });
		expect(plan.flat().filter((t) => t === "devrel")).toHaveLength(1);
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
		// Promoted into a topic slot, so it comes straight after the mention
		// and team queries, ahead of the signal rotation.
		expect(plan.findIndex((q) => q[0] === "roadmap")).toBe(1 + TEAM_TERMS.length);
	});

	it("can drop a team term the owner keeps marking as noise", () => {
		const plan = buildQueryPlan({
			ownerId: OWNER,
			topics: [],
			now,
			signals: [{ term: "devrel", positive: 0, negative: 3 }],
		});
		expect(plan.flat()).not.toContain("devrel");
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
		isBot: false,
		context: "",
	};
}

describe("threadKey", () => {
	it("uses the permalink's thread_ts for a reply", () => {
		expect(threadKey(hit("1792143734.978529", "U1", THREAD_ROOT))).toBe(`${CHANNEL}:${THREAD_ROOT}`);
	});

	it("puts a thread parent in its own thread", () => {
		expect(threadKey(hit(THREAD_ROOT, "U1", THREAD_ROOT))).toBe(`${CHANNEL}:${THREAD_ROOT}`);
	});

	it("treats a message that starts no thread as its own root", () => {
		expect(threadKey(hit("1792000000.000001", "U1"))).toBe(`${CHANNEL}:1792000000.000001`);
	});
});

describe("lastOwnerPosts", () => {
	it("keeps the owner's latest post per thread", () => {
		const posts = lastOwnerPosts([hit("1792143600.000000", OWNER, THREAD_ROOT), hit("1792143700.000000", OWNER, THREAD_ROOT)], OWNER);
		expect(posts.get(`${CHANNEL}:${THREAD_ROOT}`)).toBe(1792143700);
	});

	it("ignores posts by anyone else when building the owner's history", () => {
		const posts = lastOwnerPosts([hit("1792143700.000000", "U1", THREAD_ROOT)], OWNER);
		expect(posts.size).toBe(0);
	});
});

describe("runDigest", () => {
	type Search = (args: { keywords: string[]; filters?: string }) => SearchHit[];

	function fakeClient(search: Search, threads: Record<string, SlackMessage[]> = {}) {
		return {
			searchJoined: async (args: { keywords: string[]; filters?: string }) => ({ hits: search(args), nextCursor: null }),
			readChannel: async () => [],
			readThread: async (channelId: string, rootTs: string) => {
				const thread = threads[`${channelId}:${rootTs}`];
				if (!thread) throw new Error("no such thread");
				return thread;
			},
		} as unknown as Pick<SlackClient, "searchJoined" | "readChannel" | "readThread">;
	}

	function fakeStore(overrides: Partial<DigestStore> = {}) {
		let host: string | null = null;
		const store: DigestStore = {
			activeTopics: () => ["Vibe"],
			signals: () => [],
			focusChannels: () => [],
			briefedLatest: () => undefined,
			recentBriefingItems: () => [],
			preferenceProfile: () => structuredClone(DEFAULT_PROFILE),
			workspaceHost: () => host,
			setWorkspaceHost: (h) => {
				host = h;
			},
			...overrides,
		};
		return store;
	}

	const launchRoot = ts(10);
	const mentionTs = ts(40);
	const search: Search = (args) => {
		if (args.keywords[0] === `<@${OWNER}>`) {
			return [hitAt(mentionTs, "U7", { channelName: "#devrel", text: `<@${OWNER}> can you review the OCR cookbook draft by Thursday?` })];
		}
		if (args.keywords[0] === "Vibe") {
			return [hitAt(ts(20), "U2", { threadTs: launchRoot, channelName: "#vibe", text: "GA moves to 19 Nov" })];
		}
		return [];
	};
	const threads = {
		[`${hitAt(launchRoot, "U1").channelId}:${launchRoot}`]: [
			slackMessage(launchRoot, "U1", "Vibe 2.0 launch plan, targeting 12 Nov"),
			slackMessage(ts(20), "U2", "GA moves to 19 Nov, pricing page needs another pass"),
			slackMessage(ts(25), "U3", "DevRel should have a launch-day demo ready"),
		],
	};

	const findings = (prompt: string) => {
		// The reader sees ids it assigned; find which one holds which thread.
		const idFor = (needle: string) => {
			const match = new RegExp(`<conversation id=\\\\"(T\\d+)\\\\"[^>]*>[^<]*${needle}`).exec(prompt);
			return match?.[1] ?? "T0";
		};
		return {
			findings: [
				{
					conversation: idFor("GA moves to 19 Nov"),
					kind: "planned",
					summary: "Vibe 2.0 GA moved from 12 to 19 Nov; the pricing page needs another pass.",
					products: ["Vibe"],
					when: "19 Nov",
					certainty: "confirmed",
					forOwner: false,
					people: ["Person U2"],
					devrelValue: 85,
					contentValue: 80,
				},
			],
		};
	};

	const draft = {
		tldr: "Vibe 2.0 GA moved to 19 Nov; a launch-day demo is the strongest play.",
		needsYou: [],
		whatsNew: [{ text: "Vibe 2.0 GA moved from 12 to 19 Nov", isUpdate: false, certainty: "confirmed", findings: ["F1"] }],
		opportunities: [],
		contentIdeas: [
			{
				title: "Ship a coding agent with Vibe 2.0",
				format: "video",
				hook: "Zero to PR in ten minutes",
				whyNow: "GA on 19 Nov",
				effort: "medium",
				findings: ["F1"],
			},
		],
	};

	it("digests conversations into one numbered briefing", async () => {
		const { model, prompts } = scriptedModel(findings, draft);
		const result = await runDigest({
			client: fakeClient(search, threads),
			store: fakeStore(),
			model,
			ownerId: OWNER,
			timeZone: "Europe/London",
			since: SINCE,
			now: NOW,
		});

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const { items, tldr } = result.briefing;
		expect(tldr).toContain("19 Nov");
		expect(items.map((i) => [i.number, i.section])).toEqual([
			[1, "needs_you"],
			[2, "whats_new"],
			[3, "content_idea"],
		]);

		// The mention the model never saw a finding for is put back by the guard.
		expect(items[0].text).toContain("review the OCR cookbook draft");
		// Sources are ours, not the model's: the verified permalink of the hit,
		// which opens the thread at the reply that matched.
		expect(items[1].sources[0].permalink).toBe(permalink(CHANNEL, ts(20), launchRoot));
		expect(items[1].sources[0].latestTs).toBe(ts(25));
		expect(items[2].format).toBe("video");

		// The reader saw the whole thread, not just the keyword hit.
		expect(prompts[0]).toContain("DevRel should have a launch-day demo ready");
		expect(prompts).toHaveLength(2);
		expect(result.stats).toMatchObject({ candidates: 2, findings: 1, surfaced: 3 });
	});

	it("tells the editor what was briefed recently", async () => {
		const { model, prompts } = scriptedModel(findings, draft);
		await runDigest({
			client: fakeClient(search, threads),
			store: fakeStore({
				recentBriefingItems: () => [{ section: "whats_new", text: "Vibe 2.0 GA set for 12 Nov", createdAt: NOW.getTime() - 86_400_000 }],
			}),
			model,
			ownerId: OWNER,
			timeZone: "Europe/London",
			since: SINCE,
			now: NOW,
		});
		expect(prompts[1]).toContain("Vibe 2.0 GA set for 12 Nov");
	});

	it("falls back to unedited findings when the editor fails", async () => {
		const { model } = scriptedModel(findings, new Error("editor unavailable"));
		const result = await runDigest({
			client: fakeClient(search, threads),
			store: fakeStore(),
			model,
			ownerId: OWNER,
			timeZone: "Europe/London",
			since: SINCE,
			now: NOW,
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.briefing.items.map((i) => i.section)).toEqual(["needs_you", "whats_new"]);
	});

	it("fails the run when no batch could be read, so the scheduler retries", async () => {
		const { model } = scriptedModel(new Error("model unavailable"));
		await expect(
			runDigest({
				client: fakeClient(search, threads),
				store: fakeStore(),
				model,
				ownerId: OWNER,
				timeZone: "Europe/London",
				since: SINCE,
				now: NOW,
			}),
		).rejects.toThrow();
	});

	it("never calls the model on a quiet day", async () => {
		const { model, prompts } = scriptedModel(findings, draft);
		const result = await runDigest({
			client: fakeClient(() => []),
			store: fakeStore(),
			model,
			ownerId: OWNER,
			timeZone: "Europe/London",
			since: SINCE,
			now: NOW,
		});
		expect(result.status).toBe("empty");
		expect(prompts).toHaveLength(0);
	});

	it("does not re-brief conversations that have not moved", async () => {
		const { model, prompts } = scriptedModel(findings, draft);
		const result = await runDigest({
			client: fakeClient(search, threads),
			store: fakeStore({ briefedLatest: () => Number(ts(60)) }),
			model,
			ownerId: OWNER,
			timeZone: "Europe/London",
			since: SINCE,
			now: NOW,
		});
		expect(result.status).toBe("empty");
		expect(result.stats.briefedBefore).toBe(2);
		expect(prompts).toHaveLength(0);
	});

	it("remembers the workspace host for building links later", async () => {
		const store = fakeStore();
		const { model } = scriptedModel(findings, draft);
		await runDigest({
			client: fakeClient(search, threads),
			store,
			model,
			ownerId: OWNER,
			timeZone: "Europe/London",
			since: SINCE,
			now: NOW,
		});
		expect(store.workspaceHost()).toBe(HOST);
	});
});
