import { watchlistAction } from "../feedback";
import type { SlackClient } from "../slack/client";
import {
	buildPermalink,
	cleanAuthorName,
	parseSlackLocalTime,
	permalinkMatches,
	workspaceHostOf,
	type SearchHit,
	type SlackMessage,
} from "../slack/parse";
import { emptyStats, type Assessment, type Candidate, type Conversation, type ConversationMessage, type DigestStats } from "./types";

/**
 * Collection: find the conversations worth reading, then read them whole.
 *
 * Search is the scarce call. Slack allows a user about ten a minute and
 * counts every page, so it is spent on discovery: mentions, watchlist topics
 * and rotating signal terms. Thread reads are cheap (50+ a minute), so the
 * most promising conversations are then read in full. That is what lets the
 * model digest a discussion instead of triaging one keyword-matched message
 * at a time.
 */

/** Query slots per run, mention query included. */
export const SEARCH_BUDGET = 8;
export const MAX_TOPIC_QUERIES = 4;
export const MAX_FOCUS_CHANNELS = 8;
/** Thread reads per run. */
export const MAX_EXPANSIONS = 25;
/** Conversations handed to the model. */
export const MAX_CANDIDATES = 60;
/** Mentions are the one query worth a second page. */
const MENTION_PAGES = 2;
const PAGE_SIZE = 20;
const READ_CONCURRENCY = 4;
/** Focus channels are read this far before the window, to catch older threads that came back to life. */
const FOCUS_LOOKBACK_SECONDS = 2 * 86_400;
/** New messages shorter than this, once emoji are removed, are acknowledgements. */
const MIN_CONTENT_CHARS = 15;

export const MENTION_TERM = "@mentions";
export const OWNER_THREAD_TERM = "@you";
export const FOCUS_TERM = "focus";
/** Terms that describe how a conversation was found rather than what it is about. */
export const STRUCTURAL_TERMS: ReadonlySet<string> = new Set([MENTION_TERM, OWNER_THREAD_TERM, FOCUS_TERM]);

const UPCOMING_SIGNALS = ["launch", "roadmap", "shipping", "GA", "beta", "rollout"];
const CONTENT_SIGNALS = ["blog", "talk", "demo", "webinar", "cookbook", "tutorial"];

export type TopicSignal = { term: string; positive: number; negative: number };

const dayIndex = (now: Date) => Math.floor(now.getTime() / 86_400_000);

function rotate(pool: string[], now: Date, count: number): string[] {
	if (pool.length === 0 || count <= 0) return [];
	const start = dayIndex(now) % pool.length;
	return Array.from({ length: Math.min(count, pool.length) }, (_, i) => pool[(start + i) % pool.length]);
}

/**
 * Build the day's query plan. The first query is always the owner mention.
 *
 * Feedback steers this: terms the owner rated useful are promoted into the
 * scarce topic slots, and terms marked as noise are dropped from the rotating
 * pools entirely.
 */
export function buildQueryPlan(opts: { ownerId: string; topics: string[]; now: Date; signals?: TopicSignal[] }): string[][] {
	const promoted: string[] = [];
	const demoted = new Set<string>();

	for (const s of opts.signals ?? []) {
		const action = watchlistAction(s.positive, s.negative);
		if (action === "promote") promoted.push(s.term);
		if (action === "demote") demoted.add(s.term);
	}

	const topics = [...opts.topics, ...promoted].filter((t, i, all) => !demoted.has(t) && all.indexOf(t) === i);

	const plan: string[][] = [[`<@${opts.ownerId}>`]];
	for (const topic of topics.slice(0, MAX_TOPIC_QUERIES)) plan.push([topic]);

	const remaining = Math.max(0, SEARCH_BUDGET - plan.length);
	const upcomingCount = Math.ceil(remaining / 2);

	for (const s of rotate(
		UPCOMING_SIGNALS.filter((x) => !demoted.has(x)),
		opts.now,
		upcomingCount,
	)) {
		plan.push([s]);
	}
	for (const s of rotate(
		CONTENT_SIGNALS.filter((x) => !demoted.has(x)),
		opts.now,
		remaining - upcomingCount,
	)) {
		plan.push([s]);
	}

	return plan.slice(0, SEARCH_BUDGET);
}

/**
 * The thread a hit belongs to, as `channel:root_ts`.
 *
 * Search results carry no thread field; the permalink's `thread_ts` is the
 * only place it appears. A message that starts no thread is its own root.
 */
export function threadKey(hit: SearchHit): string {
	let root = hit.ts;
	if (hit.permalink) {
		try {
			root = new URL(hit.permalink).searchParams.get("thread_ts") ?? hit.ts;
		} catch {
			// keep the message's own ts
		}
	}
	return `${hit.channelId ?? "?"}:${root}`;
}

/** The owner's latest post per thread, keyed by `threadKey`. */
export function lastOwnerPosts(hits: SearchHit[], ownerId: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const hit of hits) {
		if (hit.authorId !== ownerId) continue;
		const key = threadKey(hit);
		const ts = Number(hit.ts);
		if (ts > (out.get(key) ?? 0)) out.set(key, ts);
	}
	return out;
}

const normalizeChannelName = (name: string | null | undefined) => (name ?? "").replace(/^#/, "").trim() || null;

function addMessage(conv: Conversation, message: ConversationMessage): void {
	const existing = conv.messages.find((m) => m.ts === message.ts);
	if (existing) {
		// A thread read and a search hit describe the same message. Keep the
		// mention flag, which only the search knows about, and the fuller
		// text, since a search result can be cut short.
		existing.mentionsOwner ||= message.mentionsOwner;
		existing.isBot ||= message.isBot;
		existing.authorName ??= message.authorName;
		if (message.text.length > existing.text.length) existing.text = message.text;
		return;
	}
	conv.messages.push(message);
	conv.messages.sort((a, b) => Number(a.ts) - Number(b.ts));
	conv.activityTs = Math.max(conv.activityTs, Number(message.ts));
}

function addTerm(conv: Conversation, term: string): void {
	if (!conv.terms.includes(term)) conv.terms.push(term);
}

function upsert(
	into: Map<string, Conversation>,
	seed: Pick<Conversation, "key" | "channelId" | "channelName" | "rootTs" | "permalink" | "expandable">,
): Conversation {
	const existing = into.get(seed.key);
	if (existing) {
		existing.channelName ??= seed.channelName;
		existing.permalink ??= seed.permalink;
		existing.expandable ||= seed.expandable;
		return existing;
	}
	const conv: Conversation = { ...seed, messages: [], context: "", terms: [], expanded: false, activityTs: 0 };
	into.set(seed.key, conv);
	return conv;
}

/**
 * Fold search hits into conversations, one per thread.
 *
 * Three hits from one launch thread become one conversation, not three
 * briefing items.
 */
export function groupHits(
	entries: Array<{ hit: SearchHit; term: string; mention?: boolean }>,
	into = new Map<string, Conversation>(),
): Map<string, Conversation> {
	for (const { hit, term, mention } of entries) {
		const channelId = hit.channelId;
		// Direct messages never enter the digest, even if the gateway ignored
		// `channel_types`: the owner's DM is where the briefing itself lives.
		if (!channelId || channelId.startsWith("D")) continue;
		// A permalink that does not point at its own message is dropped rather
		// than shown, so no link can be attached to the wrong conversation.
		if (!permalinkMatches(hit.permalink, channelId, hit.ts)) continue;

		const key = threadKey(hit);
		const rootTs = key.slice(key.indexOf(":") + 1);
		const conv = upsert(into, {
			key,
			channelId,
			channelName: normalizeChannelName(hit.channelName),
			rootTs,
			permalink: hit.permalink,
			expandable: true,
		});
		if (hit.ts === rootTs) conv.permalink = hit.permalink;

		addMessage(conv, {
			ts: hit.ts,
			authorId: hit.authorId,
			authorName: cleanAuthorName(hit.authorName),
			text: hit.text,
			isBot: hit.isBot,
			mentionsOwner: mention ?? false,
		});
		addTerm(conv, term);
		if (hit.context && !conv.context.includes(hit.context)) {
			conv.context = [conv.context, hit.context].filter(Boolean).join("\n").slice(0, 1_500);
		}
	}
	return into;
}

function fromSlackMessage(m: SlackMessage): ConversationMessage {
	return { ts: m.ts, authorId: m.authorId, authorName: cleanAuthorName(m.authorName), text: m.text, isBot: false };
}

/**
 * Conversations from a focus channel read: every top-level message in the
 * window, plus older threads whose latest reply falls inside it.
 */
export function channelConversations(opts: {
	channelId: string;
	channelName: string | null;
	messages: SlackMessage[];
	sinceMs: number;
	host: string | null;
}): Conversation[] {
	const sinceSec = opts.sinceMs / 1000;
	const out: Conversation[] = [];

	for (const m of opts.messages) {
		const ts = Number(m.ts);
		const threadLatest = parseSlackLocalTime(m.threadLatest);
		const revived = threadLatest !== null && threadLatest >= opts.sinceMs;
		if (ts < sinceSec && !revived) continue;

		const conv: Conversation = {
			key: `${opts.channelId}:${m.ts}`,
			channelId: opts.channelId,
			channelName: normalizeChannelName(opts.channelName),
			rootTs: m.ts,
			permalink: buildPermalink(opts.host, opts.channelId, m.ts),
			messages: [],
			context: "",
			terms: [FOCUS_TERM],
			expandable: (m.threadReplyCount ?? 0) > 0,
			expanded: false,
			activityTs: threadLatest !== null ? threadLatest / 1000 : 0,
		};
		addMessage(conv, fromSlackMessage(m));
		out.push(conv);
	}
	return out;
}

function mergeConversation(into: Map<string, Conversation>, conv: Conversation): void {
	const target = upsert(into, conv);
	for (const m of conv.messages) addMessage(target, m);
	for (const t of conv.terms) addTerm(target, t);
	target.activityTs = Math.max(target.activityTs, conv.activityTs);
}

/**
 * Decide whether a conversation still has something new for the owner.
 *
 * The gateway exposes no read state, so engagement stands in for it: if the
 * owner posted after everyone else, they have seen it. A reply that arrived
 * after the owner's last post is kept, and flagged, because someone is
 * waiting on them.
 */
export function assessConversation(
	conv: Conversation,
	ctx: { ownerId: string; sinceSec: number; ownerLastPost?: number; briefedLatest?: number },
): Assessment {
	const token = `<@${ctx.ownerId}>`;
	const briefed = ctx.briefedLatest ?? 0;
	let ownerLast = ctx.ownerLastPost ?? 0;
	const others: ConversationMessage[] = [];

	for (const m of conv.messages) {
		if (m.authorId === ctx.ownerId) ownerLast = Math.max(ownerLast, Number(m.ts));
		else others.push(m);
	}

	const fresh = others.filter((m) => Number(m.ts) >= ctx.sinceSec && Number(m.ts) > briefed);
	const latestOtherTs = others.reduce((max, m) => Math.max(max, Number(m.ts)), 0);
	const assessment: Assessment = {
		status: "keep",
		mentionsOwner: fresh.some((m) => Number(m.ts) > ownerLast && (m.mentionsOwner === true || m.text.includes(token))),
		awaitingOwner: ownerLast > 0 && latestOtherTs > ownerLast,
		newMessages: fresh.length,
		participants: new Set(conv.messages.map((m) => m.authorId ?? m.authorName ?? "?")).size,
		latestOtherTs,
	};

	if (others.length === 0) return { ...assessment, status: "own" };
	if (others.every((m) => m.isBot)) return { ...assessment, status: "bots" };
	if (ownerLast >= latestOtherTs) return { ...assessment, status: "engaged" };
	if (fresh.length === 0) return { ...assessment, status: briefed > 0 ? "briefed" : "stale" };

	const content = fresh
		.filter((m) => !m.isBot)
		.map((m) => m.text)
		.join(" ")
		.replace(/:[a-z0-9_+-]+:/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!assessment.mentionsOwner && content.length < MIN_CONTENT_CHARS) return { ...assessment, status: "trivial" };

	return assessment;
}

/**
 * Rank a conversation. Before a thread read only the search terms are known;
 * afterwards the assessment adds who is waiting on whom.
 */
export function scoreConversation(conv: Conversation, assessment: Assessment | null, watchlist: ReadonlySet<string>): number {
	let score = 0;
	const mention = assessment ? assessment.mentionsOwner : conv.terms.includes(MENTION_TERM);
	if (mention) score += 100;
	if (assessment?.awaitingOwner) score += 50;
	else if (!assessment && conv.terms.includes(OWNER_THREAD_TERM)) score += 25;

	const topical = conv.terms.filter((t) => !STRUCTURAL_TERMS.has(t));
	const topics = topical.filter((t) => watchlist.has(t.toLowerCase())).length;
	score += 30 * Math.min(2, topics);
	score += 10 * Math.min(2, topical.length - topics);
	if (conv.terms.includes(FOCUS_TERM)) score += 20;
	score += Math.min(20, Math.round(4 * Math.log2(1 + conv.messages.length)));
	return score;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) await fn(items[next++]);
	});
	await Promise.all(workers);
}

export type CollectResult = {
	candidates: Candidate[];
	stats: DigestStats;
	/** Learned from search permalinks, so focus-channel links can be built. */
	workspaceHost: string | null;
};

export async function collectConversations(opts: {
	client: Pick<SlackClient, "searchJoined" | "readChannel" | "readThread">;
	plan: string[][];
	ownerId: string;
	since: Date;
	watchlist: string[];
	focusChannels: Array<{ channelId: string; name: string }>;
	workspaceHost: string | null;
	briefedLatest: (key: string) => number | undefined;
}): Promise<CollectResult> {
	const stats = emptyStats();
	const sinceSec = Math.floor(opts.since.getTime() / 1000);
	const after = sinceSec.toString();
	const conversations = new Map<string, Conversation>();
	const seen = new Set<string>();
	let host = opts.workspaceHost;

	const note = (channelId: string | null, ts: string) => seen.add(`${channelId ?? "?"}:${ts}`);

	const search = async (args: { keywords: string[]; filters?: string; naturalLanguageQuery?: string; includeContext?: boolean }, pages: number) => {
		const hits: SearchHit[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < pages; page++) {
			stats.searches++;
			let result: Awaited<ReturnType<typeof opts.client.searchJoined>>;
			try {
				result = await opts.client.searchJoined({ ...args, after, limit: PAGE_SIZE, cursor });
			} catch (error) {
				// A later page failing keeps what the earlier ones found.
				if (page === 0) throw error;
				break;
			}
			hits.push(...result.hits);
			if (!result.nextCursor || result.hits.length < PAGE_SIZE) break;
			cursor = result.nextCursor;
		}
		for (const hit of hits) {
			note(hit.channelId, hit.ts);
			host ??= workspaceHostOf(hit.permalink);
		}
		return hits;
	};

	for (const [index, keywords] of opts.plan.entries()) {
		const mention = index === 0;
		const term = mention ? MENTION_TERM : keywords[0];
		try {
			const hits = await search(
				{
					keywords,
					naturalLanguageQuery: mention ? "" : `${keywords[0]} news relevant to a developer advocate`,
				},
				mention ? MENTION_PAGES : 1,
			);
			groupHits(
				hits.map((hit) => ({ hit, term, mention })),
				conversations,
			);
		} catch {
			// A failed query degrades coverage, not the run.
		}
	}

	// The owner's own posts in the window: what they have already answered,
	// and threads where someone has answered them. Posts before the window
	// cannot postdate any hit, so the window is exactly what is needed.
	let ownerPosts = new Map<string, number>();
	try {
		const posts = (await search({ keywords: [], filters: `from:<@${opts.ownerId}>`, includeContext: false }, 1)).filter(
			(hit) => hit.authorId === opts.ownerId,
		);
		ownerPosts = lastOwnerPosts(posts, opts.ownerId);
		groupHits(
			posts.map((hit) => ({ hit, term: OWNER_THREAD_TERM })),
			conversations,
		);
	} catch {
		// Degrades to surfacing threads the owner already answered.
	}

	for (const channel of opts.focusChannels.slice(0, MAX_FOCUS_CHANNELS)) {
		try {
			stats.reads++;
			const messages = await opts.client.readChannel(channel.channelId, {
				oldest: (sinceSec - FOCUS_LOOKBACK_SECONDS).toString(),
				limit: 100,
			});
			for (const m of messages) note(channel.channelId, m.ts);
			for (const conv of channelConversations({
				channelId: channel.channelId,
				channelName: channel.name,
				messages,
				sinceMs: opts.since.getTime(),
				host,
			})) {
				mergeConversation(conversations, conv);
			}
		} catch {
			// One unreadable channel should not cost the rest.
		}
	}

	stats.conversations = conversations.size;

	// Skip anything briefed before that has not moved since.
	const pool: Conversation[] = [];
	for (const conv of conversations.values()) {
		const briefed = opts.briefedLatest(conv.key);
		if (briefed !== undefined && conv.activityTs <= briefed) {
			stats.briefedBefore++;
			continue;
		}
		pool.push(conv);
	}

	// Read the most promising threads in full. A keyword hit is one message;
	// the decision, the date and the ask are usually in the replies.
	const watchlist = new Set(opts.watchlist.map((t) => t.toLowerCase()));
	pool.sort((a, b) => scoreConversation(b, null, watchlist) - scoreConversation(a, null, watchlist) || b.activityTs - a.activityTs);
	await mapLimit(
		pool.filter((c) => c.expandable).slice(0, MAX_EXPANSIONS),
		READ_CONCURRENCY,
		async (conv) => {
			stats.reads++;
			try {
				const thread = await opts.client.readThread(conv.channelId, conv.rootTs, { limit: 200 });
				for (const m of thread) {
					addMessage(conv, fromSlackMessage(m));
					note(conv.channelId, m.ts);
				}
				conv.expanded = thread.length > 0;
			} catch {
				// The hits alone still describe it.
			}
		},
	);

	const candidates: Candidate[] = [];
	for (const conv of pool) {
		const briefedLatest = opts.briefedLatest(conv.key) ?? 0;
		const assessment = assessConversation(conv, {
			ownerId: opts.ownerId,
			sinceSec,
			ownerLastPost: ownerPosts.get(conv.key),
			briefedLatest,
		});
		if (assessment.status === "keep") {
			candidates.push({ ...conv, assessment, score: scoreConversation(conv, assessment, watchlist), briefedLatest, sinceSec });
		} else if (assessment.status === "own" || assessment.status === "engaged") {
			stats.engaged++;
		} else if (assessment.status === "briefed") {
			stats.briefedBefore++;
		}
	}

	candidates.sort((a, b) => b.score - a.score || b.assessment.latestOtherTs - a.assessment.latestOtherTs);
	const kept = candidates.slice(0, MAX_CANDIDATES);

	stats.candidates = kept.length;
	stats.messages = seen.size;
	stats.channels = new Set([...conversations.values()].map((c) => c.channelId)).size;
	return { candidates: kept, stats, workspaceHost: host };
}
