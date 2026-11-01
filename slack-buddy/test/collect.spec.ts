import { describe, expect, it } from "vitest";
import {
	FOCUS_TERM,
	MAX_EXPANSIONS,
	MENTION_TERM,
	OWNER_THREAD_TERM,
	assessConversation,
	channelConversations,
	collectConversations,
	groupHits,
	scoreConversation,
} from "../src/digest/collect";
import type { Conversation } from "../src/digest/types";
import type { SlackClient } from "../src/slack/client";
import type { SearchHit, SlackMessage } from "../src/slack/parse";
import { CHANNEL, HOST, OWNER, SINCE, SINCE_SEC, hit, message, slackMessage, ts } from "./helpers";

const conversation = (messages: Conversation["messages"], terms: string[] = ["Vibe"]): Conversation => ({
	key: `${CHANNEL}:${messages[0].ts}`,
	channelId: CHANNEL,
	channelName: "devrel",
	rootTs: messages[0].ts,
	permalink: null,
	messages,
	context: "",
	terms,
	expandable: false,
	expanded: true,
	activityTs: Math.max(...messages.map((m) => Number(m.ts))),
});

describe("groupHits", () => {
	it("folds hits from one thread into one conversation", () => {
		const root = ts(10);
		const map = groupHits([
			{ hit: hit(root, "U1", { threadTs: root }), term: "Vibe" },
			{ hit: hit(ts(20), "U2", { threadTs: root }), term: "launch" },
			{ hit: hit(ts(30), "U3", { threadTs: root }), term: "Vibe" },
		]);

		expect(map.size).toBe(1);
		const [conv] = map.values();
		expect(conv.key).toBe(`${CHANNEL}:${root}`);
		expect(conv.messages.map((m) => m.ts)).toEqual([root, ts(20), ts(30)]);
		expect(conv.terms).toEqual(["Vibe", "launch"]);
	});

	it("keeps unrelated top-level messages apart", () => {
		const map = groupHits([
			{ hit: hit(ts(10), "U1"), term: "Vibe" },
			{ hit: hit(ts(20), "U2"), term: "Vibe" },
		]);
		expect(map.size).toBe(2);
	});

	it("drops a hit whose permalink points at another message", () => {
		const bad: SearchHit = { ...hit(ts(10), "U1"), permalink: hit(ts(99), "U1").permalink };
		expect(groupHits([{ hit: bad, term: "Vibe" }]).size).toBe(0);
	});

	it("never lets a direct message into the digest", () => {
		const dm = hit(ts(10), "U1", { channelId: "D0BTQQF7WCW" });
		expect(groupHits([{ hit: dm, term: "Vibe" }]).size).toBe(0);
	});

	it("strips emails from author names", () => {
		const [conv] = groupHits([{ hit: hit(ts(10), "U1"), term: "Vibe" }]).values();
		expect(conv.messages[0].authorName).toBe("Person U1");
	});

	it("remembers which messages the mention search returned", () => {
		const [conv] = groupHits([{ hit: hit(ts(10), "U1", { text: "@Confidence can you look?" }), term: MENTION_TERM, mention: true }]).values();
		expect(conv.messages[0].mentionsOwner).toBe(true);
	});
});

describe("assessConversation", () => {
	const ctx = { ownerId: OWNER, sinceSec: SINCE_SEC };

	it("keeps a conversation with something new", () => {
		const a = assessConversation(conversation([message(ts(10), "U1", "Vibe 2.0 GA moves to 19 Nov")]), ctx);
		expect(a.status).toBe("keep");
	});

	it("drops a conversation the owner answered last", () => {
		const a = assessConversation(
			conversation([message(ts(10), "U1", "Can DevRel own the launch demo?"), message(ts(20), OWNER, "Yes, on it")]),
			ctx,
		);
		expect(a.status).toBe("engaged");
	});

	it("keeps, and flags, a reply that arrived after the owner's last post", () => {
		// Someone answering the owner is exactly what the briefing must not hide.
		const a = assessConversation(
			conversation([message(ts(10), OWNER, "Does the OCR API support PDFs?"), message(ts(20), "U1", "Yes, up to 1,000 pages per file")]),
			ctx,
		);
		expect(a.status).toBe("keep");
		expect(a.awaitingOwner).toBe(true);
	});

	it("uses the owner-post search when the thread read missed the owner's reply", () => {
		const a = assessConversation(conversation([message(ts(10), "U1", "Can DevRel own the launch demo?")]), {
			...ctx,
			ownerLastPost: Number(ts(30)),
		});
		expect(a.status).toBe("engaged");
	});

	it("drops the owner's own monologue", () => {
		expect(assessConversation(conversation([message(ts(10), OWNER, "Notes to self about the cookbook")]), ctx).status).toBe("own");
	});

	it("drops bot-only conversations", () => {
		expect(assessConversation(conversation([message(ts(10), "B1", "Deploy succeeded", { isBot: true })]), ctx).status).toBe("bots");
	});

	it("drops acknowledgements", () => {
		const a = assessConversation(
			conversation([message(ts(-60), OWNER, "Shipped the cookbook"), message(ts(10), "U1", "thanks! :tada:")]),
			ctx,
		);
		expect(a.status).toBe("trivial");
	});

	it("keeps a short message when it mentions the owner", () => {
		const a = assessConversation(conversation([message(ts(10), "U1", `<@${OWNER}> ?`)]), ctx);
		expect(a.status).toBe("keep");
		expect(a.mentionsOwner).toBe(true);
	});

	it("treats a flagged mention as a mention whatever the text looks like", () => {
		const a = assessConversation(conversation([message(ts(10), "U1", "@Confidence can you review this?", { mentionsOwner: true })]), ctx);
		expect(a.mentionsOwner).toBe(true);
	});

	it("does not count a mention the owner already answered", () => {
		const a = assessConversation(
			conversation([
				message(ts(10), "U1", `<@${OWNER}> can you review this?`),
				message(ts(20), OWNER, "Done"),
				message(ts(30), "U2", "Great, merging now and updating the docs"),
			]),
			ctx,
		);
		expect(a.status).toBe("keep");
		expect(a.mentionsOwner).toBe(false);
	});

	it("drops a briefed thread with nothing newer", () => {
		const a = assessConversation(conversation([message(ts(10), "U1", "Vibe 2.0 GA moves to 19 Nov")]), {
			...ctx,
			briefedLatest: Number(ts(10)),
		});
		expect(a.status).toBe("briefed");
	});

	it("keeps a briefed thread that has moved since", () => {
		const a = assessConversation(
			conversation([message(ts(10), "U1", "Vibe 2.0 GA moves to 19 Nov"), message(ts(40), "U2", "Update: GA slips again to 26 Nov")]),
			{ ...ctx, briefedLatest: Number(ts(10)) },
		);
		expect(a.status).toBe("keep");
		expect(a.newMessages).toBe(1);
	});

	it("does not treat context from before the window as new", () => {
		const a = assessConversation(conversation([message(ts(-120), "U1", "Long discussion about pricing pages")]), ctx);
		expect(a.status).toBe("stale");
	});
});

describe("channelConversations", () => {
	const read = (messages: SlackMessage[]) =>
		channelConversations({ channelId: CHANNEL, channelName: "launches", messages, sinceMs: SINCE.getTime(), host: HOST });

	it("takes every top-level message in the window", () => {
		const convs = read([slackMessage(ts(10), "U1", "Codestral 3 is live"), slackMessage(ts(20), "U2", "Docs updated")]);
		expect(convs).toHaveLength(2);
		expect(convs[0].terms).toEqual([FOCUS_TERM]);
	});

	it("skips older messages whose threads are quiet", () => {
		expect(read([slackMessage(ts(-600), "U1", "Old news")])).toHaveLength(0);
	});

	it("revives an older thread with a reply inside the window", () => {
		// 2026-09-17 06:00 BST is inside a window that opened 2026-09-16 14:30 BST.
		const convs = read([
			slackMessage(ts(-600), "U1", "Launch plan for Vibe 2.0", {
				threadReplyCount: 12,
				threadLatest: "2026-09-17 06:00:00 BST",
			}),
		]);
		expect(convs).toHaveLength(1);
		expect(convs[0].expandable).toBe(true);
	});

	it("builds permalinks from known ids, since channel reads return none", () => {
		const [conv] = read([slackMessage(ts(10), "U1", "Codestral 3 is live")]);
		expect(conv.permalink).toBe(`https://${HOST}/archives/${CHANNEL}/p${ts(10).replace(".", "")}`);
	});

	it("marks only threads with replies for a thread read", () => {
		const [quiet, busy] = read([
			slackMessage(ts(10), "U1", "Codestral 3 is live"),
			slackMessage(ts(20), "U2", "Pricing questions", { threadReplyCount: 3, threadLatest: "2026-09-17 06:00:00 BST" }),
		]);
		expect(quiet.expandable).toBe(false);
		expect(busy.expandable).toBe(true);
	});
});

describe("scoreConversation", () => {
	const watch = new Set(["vibe"]);
	const base = conversation([message(ts(10), "U1", "text")], []);

	it("ranks a mention above everything else", () => {
		const mention = scoreConversation({ ...base, terms: [MENTION_TERM] }, null, watch);
		const topic = scoreConversation({ ...base, terms: ["Vibe", FOCUS_TERM, "launch"] }, null, watch);
		expect(mention).toBeGreaterThan(topic);
	});

	it("ranks a watchlist topic above a generic signal term", () => {
		expect(scoreConversation({ ...base, terms: ["Vibe"] }, null, watch)).toBeGreaterThan(
			scoreConversation({ ...base, terms: ["launch"] }, null, watch),
		);
	});

	it("lifts a thread where someone is waiting on the owner", () => {
		const assessment = assessConversation(
			conversation([message(ts(10), OWNER, "Question?"), message(ts(20), "U1", "Here is a detailed answer for you")]),
			{ ownerId: OWNER, sinceSec: SINCE_SEC },
		);
		expect(scoreConversation({ ...base, terms: [OWNER_THREAD_TERM] }, assessment, watch)).toBeGreaterThanOrEqual(50);
	});
});

describe("collectConversations", () => {
	type Search = (args: { keywords: string[]; filters?: string; cursor?: string }) => { hits: SearchHit[]; nextCursor: string | null };

	function fakeClient(opts: { search?: Search; thread?: (channelId: string, rootTs: string) => SlackMessage[]; channel?: (id: string) => SlackMessage[] }) {
		const calls = {
			search: [] as Array<{ keywords: string[]; filters?: string; cursor?: string }>,
			thread: [] as string[],
			channel: [] as string[],
		};
		const client = {
			searchJoined: async (args: { keywords: string[]; filters?: string; cursor?: string }) => {
				calls.search.push(args);
				return opts.search?.(args) ?? { hits: [], nextCursor: null };
			},
			readThread: async (channelId: string, rootTs: string) => {
				calls.thread.push(`${channelId}:${rootTs}`);
				if (!opts.thread) throw new Error("thread read failed");
				return opts.thread(channelId, rootTs);
			},
			readChannel: async (channelId: string) => {
				calls.channel.push(channelId);
				return opts.channel?.(channelId) ?? [];
			},
		} as unknown as Pick<SlackClient, "searchJoined" | "readChannel" | "readThread">;
		return { client, calls };
	}

	const collect = (client: Pick<SlackClient, "searchJoined" | "readChannel" | "readThread">, extra: Partial<Parameters<typeof collectConversations>[0]> = {}) =>
		collectConversations({
			client,
			plan: [[`<@${OWNER}>`], ["Vibe"]],
			ownerId: OWNER,
			since: SINCE,
			watchlist: ["Vibe"],
			focusChannels: [],
			workspaceHost: null,
			briefedLatest: () => undefined,
			...extra,
		});

	it("reads the thread behind a keyword hit, so the model sees the whole discussion", async () => {
		const root = ts(10);
		const { client, calls } = fakeClient({
			search: (args) => (args.keywords[0] === "Vibe" ? { hits: [hit(ts(20), "U2", { threadTs: root })], nextCursor: null } : { hits: [], nextCursor: null }),
			thread: () => [
				slackMessage(root, "U1", "Vibe 2.0 launch plan"),
				slackMessage(ts(20), "U2", "GA moves to 19 Nov"),
				slackMessage(ts(25), "U3", "Can DevRel prepare a demo for launch day?"),
			],
		});

		const { candidates, stats } = await collect(client);
		expect(calls.thread).toEqual([`${CHANNEL}:${root}`]);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].messages).toHaveLength(3);
		expect(candidates[0].expanded).toBe(true);
		expect(stats.messages).toBe(3);
	});

	it("prefers the thread read's full text over a shortened search result", async () => {
		const { client } = fakeClient({
			search: (args) =>
				args.keywords[0] === "Vibe" ? { hits: [hit(ts(20), "U2", { text: "GA moves to…" })], nextCursor: null } : { hits: [], nextCursor: null },
			thread: () => [slackMessage(ts(20), "U2", "GA moves to 19 Nov, and DevRel should prepare a launch demo")],
		});
		const { candidates } = await collect(client);
		expect(candidates[0].messages[0].text).toBe("GA moves to 19 Nov, and DevRel should prepare a launch demo");
	});

	it("keeps the hits when a thread read fails", async () => {
		const { client } = fakeClient({
			search: (args) => (args.keywords[0] === "Vibe" ? { hits: [hit(ts(20), "U2")], nextCursor: null } : { hits: [], nextCursor: null }),
		});
		const { candidates } = await collect(client);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].expanded).toBe(false);
	});

	it("searches the owner's posts once, over the same window", async () => {
		const { client, calls } = fakeClient({});
		await collect(client);
		const ownerCalls = calls.search.filter((c) => c.filters);
		expect(ownerCalls).toHaveLength(1);
		expect(ownerCalls[0]).toMatchObject({
			keywords: [],
			filters: `from:<@${OWNER}>`,
			after: Math.floor(SINCE_SEC).toString(),
		});
	});

	it("drops what the owner already engaged with, and counts it", async () => {
		const root = ts(10);
		const { client } = fakeClient({
			search: (args) =>
				args.filters
					? { hits: [hit(ts(30), OWNER, { threadTs: root })], nextCursor: null }
					: args.keywords[0] === "Vibe"
						? { hits: [hit(ts(20), "U2", { threadTs: root }), hit(ts(40), OWNER)], nextCursor: null }
						: { hits: [], nextCursor: null },
			thread: (_, rootTs) =>
				rootTs === root
					? [slackMessage(root, "U1", "Vibe 2.0 launch plan"), slackMessage(ts(20), "U2", "GA 19 Nov?"), slackMessage(ts(30), OWNER, "Confirmed")]
					: [slackMessage(rootTs, OWNER, "My own note about Vibe")],
		});

		const { candidates, stats } = await collect(client);
		expect(candidates).toHaveLength(0);
		expect(stats.engaged).toBe(2);
	});

	it("finds replies to the owner's own posts", async () => {
		const root = ts(10);
		const { client } = fakeClient({
			search: (args) => (args.filters ? { hits: [hit(root, OWNER, { threadTs: root })], nextCursor: null } : { hits: [], nextCursor: null }),
			thread: () => [slackMessage(root, OWNER, "Does OCR handle handwriting?"), slackMessage(ts(30), "U1", "Yes, as of last week's model update")],
		});

		const { candidates } = await collect(client);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].terms).toContain(OWNER_THREAD_TERM);
		expect(candidates[0].assessment.awaitingOwner).toBe(true);
	});

	it("skips a briefed conversation that has not moved, without reading it", async () => {
		const { client, calls } = fakeClient({
			search: (args) => (args.keywords[0] === "Vibe" ? { hits: [hit(ts(20), "U2")], nextCursor: null } : { hits: [], nextCursor: null }),
		});
		const { candidates, stats } = await collect(client, { briefedLatest: () => Number(ts(20)) });
		expect(candidates).toHaveLength(0);
		expect(stats.briefedBefore).toBe(1);
		expect(calls.thread).toHaveLength(0);
	});

	it("pages the mention query when Slack returns a cursor", async () => {
		const full = Array.from({ length: 20 }, (_, i) => hit(ts(i + 1), `U${i}`, { text: `<@${OWNER}> question ${i}` }));
		const { client, calls } = fakeClient({
			search: (args) =>
				args.keywords[0] === `<@${OWNER}>` && !args.cursor
					? { hits: full, nextCursor: "page2" }
					: args.cursor === "page2"
						? { hits: [hit(ts(50), "U99", { text: `<@${OWNER}> one more` })], nextCursor: null }
						: { hits: [], nextCursor: null },
		});

		const { candidates } = await collect(client);
		expect(calls.search.filter((c) => c.keywords[0] === `<@${OWNER}>`)).toHaveLength(2);
		expect(candidates).toHaveLength(21);
	});

	it("caps thread reads per run", async () => {
		const hits = Array.from({ length: MAX_EXPANSIONS + 10 }, (_, i) => hit(ts(i + 1), `U${i}`));
		const { client, calls } = fakeClient({
			search: (args) => (args.keywords[0] === "Vibe" ? { hits, nextCursor: null } : { hits: [], nextCursor: null }),
			thread: (_, rootTs) => [slackMessage(rootTs, "U1", "Thread root about the Vibe launch")],
		});
		await collect(client);
		expect(calls.thread).toHaveLength(MAX_EXPANSIONS);
	});

	it("reads focus channels in full and learns the workspace host from search", async () => {
		const { client, calls } = fakeClient({
			search: (args) => (args.keywords[0] === "Vibe" ? { hits: [hit(ts(5), "U9")], nextCursor: null } : { hits: [], nextCursor: null }),
			channel: () => [slackMessage(ts(10), "U1", "Codestral 3 is now available on all tiers")],
		});

		const { candidates, workspaceHost } = await collect(client, { focusChannels: [{ channelId: "C0LAUNCHES", name: "launches" }] });
		expect(calls.channel).toEqual(["C0LAUNCHES"]);
		expect(workspaceHost).toBe(HOST);
		const focus = candidates.find((c) => c.channelId === "C0LAUNCHES");
		expect(focus?.terms).toEqual([FOCUS_TERM]);
		expect(focus?.permalink).toContain(`https://${HOST}/archives/C0LAUNCHES/`);
	});

	it("survives a failing search", async () => {
		const { client } = fakeClient({
			search: (args) => {
				if (args.keywords[0] === `<@${OWNER}>`) throw new Error("gateway down");
				return args.keywords[0] === "Vibe" ? { hits: [hit(ts(20), "U2")], nextCursor: null } : { hits: [], nextCursor: null };
			},
		});
		const { candidates } = await collect(client);
		expect(candidates).toHaveLength(1);
	});
});
