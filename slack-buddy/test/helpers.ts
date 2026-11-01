import { MockLanguageModelV4 } from "ai/test";
import type { Assessment, Candidate, ConversationMessage } from "../src/digest/types";
import type { SearchHit, SlackMessage } from "../src/slack/parse";

export const OWNER = "U0BUM44636U";
export const CHANNEL = "C08LQA773DW";
/** Enterprise Grid shape, as observed live: one more label than a plain workspace. */
export const HOST = "acme.enterprise.slack.com";

/** Thursday 2026-09-17, 08:30 BST: the scheduled briefing. */
export const NOW = new Date(Date.UTC(2026, 8, 17, 7, 30));
export const SINCE = new Date(NOW.getTime() - 18 * 3_600_000);
export const SINCE_SEC = SINCE.getTime() / 1000;

/** A Slack ts `minutes` after the window opened. Negative is before it. */
export const ts = (minutes: number) => (SINCE_SEC + minutes * 60).toFixed(6);

export const permalink = (channelId: string, messageTs: string, threadTs?: string) =>
	`https://${HOST}/archives/${channelId}/p${messageTs.replace(".", "")}${threadTs ? `?thread_ts=${threadTs}&cid=${channelId}` : ""}`;

/** A search hit as the gateway renders it; thread membership lives in the permalink. */
export function hit(
	messageTs: string,
	authorId: string,
	opts: { threadTs?: string; channelId?: string; channelName?: string; text?: string; isBot?: boolean } = {},
): SearchHit {
	const channelId = opts.channelId ?? CHANNEL;
	return {
		ts: messageTs,
		channelId,
		channelName: opts.channelName ?? "#devrel",
		authorId,
		authorName: authorId === OWNER ? "Confidence Okoghenun <confidence@mistral.ai>" : `Person ${authorId} <p@example.com>`,
		time: null,
		permalink: permalink(channelId, messageTs, opts.threadTs),
		text: opts.text ?? "We are planning the Vibe 2.0 launch for 19 November",
		isBot: opts.isBot ?? false,
		context: "",
	};
}

export function slackMessage(messageTs: string, authorId: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage {
	return {
		ts: messageTs,
		authorId,
		authorName: `Person ${authorId}`,
		text,
		sentViaApp: false,
		threadLatest: null,
		threadReplyCount: null,
		...extra,
	};
}

export function message(messageTs: string, authorId: string, text: string, extra: Partial<ConversationMessage> = {}): ConversationMessage {
	return { ts: messageTs, authorId, authorName: `Person ${authorId}`, text, isBot: false, ...extra };
}

const KEEP: Assessment = {
	status: "keep",
	mentionsOwner: false,
	awaitingOwner: false,
	newMessages: 1,
	participants: 1,
	latestOtherTs: 0,
};

export function candidate(overrides: Partial<Candidate> & { rootTs?: string } = {}): Candidate {
	const rootTs = overrides.rootTs ?? ts(60);
	const channelId = overrides.channelId ?? CHANNEL;
	return {
		key: `${channelId}:${rootTs}`,
		channelId,
		channelName: "devrel",
		rootTs,
		permalink: permalink(channelId, rootTs),
		messages: [message(rootTs, "U1", "Vibe 2.0 GA moves to 19 Nov")],
		context: "",
		terms: ["Vibe"],
		expandable: true,
		expanded: true,
		activityTs: Number(rootTs),
		assessment: { ...KEEP, ...overrides.assessment },
		score: 30,
		briefedLatest: 0,
		sinceSec: SINCE_SEC,
		...overrides,
	};
}

type Script = unknown | Error | ((prompt: string) => unknown);

/**
 * A model that answers each call with the next scripted response, as JSON.
 * An `Error` is thrown instead; the last response repeats.
 */
export function scriptedModel(...script: Script[]) {
	const prompts: string[] = [];
	let call = 0;
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			const prompt = JSON.stringify(options.prompt);
			prompts.push(prompt);
			const next = script[Math.min(call++, script.length - 1)];
			if (next instanceof Error) throw next;
			const value = typeof next === "function" ? (next as (p: string) => unknown)(prompt) : next;
			return {
				content: [{ type: "text", text: JSON.stringify(value) }],
				finishReason: { unified: "stop", raw: "stop" },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			};
		},
	});
	return { model, prompts };
}
