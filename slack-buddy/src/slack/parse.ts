/**
 * Parsers for the connectors-gateway response payloads.
 *
 * The gateway returns a JSON envelope whose fields hold human-formatted text
 * rather than structured records, so these parsers are the boundary between
 * that rendered text and typed data. They are deliberately tolerant: an
 * unrecognised line is skipped rather than throwing, because a formatting
 * change upstream should degrade the briefing, not take the agent down.
 *
 * Note the two spellings of the timestamp field. Conversation reads emit
 * `Message TS:`; search results emit `Message_ts:`. Both are handled.
 */

export type SlackMessage = {
	ts: string;
	authorId: string | null;
	authorName: string | null;
	text: string;
	/** True when the message carries the gateway's `*Sent using*` attribution. */
	sentViaApp: boolean;
	/**
	 * Raw `latest: ...` value from a `Thread: N replies (latest: ...)` line.
	 *
	 * This is a formatted local datetime with a timezone abbreviation, not a
	 * Unix timestamp, so it is kept as an opaque string and compared for
	 * change rather than ordered. Parsing `BST`/`GMT` would add a timezone
	 * dependency for no benefit.
	 */
	threadLatest: string | null;
	threadReplyCount: number | null;
};

export type SearchHit = {
	ts: string;
	channelId: string | null;
	channelName: string | null;
	authorId: string | null;
	authorName: string | null;
	time: string | null;
	permalink: string | null;
	text: string;
};

const HEADER_INLINE = /^=== Message from (.+?) \(([^()]+)\) at (.+?) ===\s*$/;
const HEADER_PARENT = /^=== THREAD PARENT MESSAGE ===\s*$/;
const HEADER_REPLY = /^--- Reply \d+ of \d+ ---\s*$/;
const SECTION = /^=== THREAD REPLIES \(\d+ total\) ===\s*$/;
const FROM = /^From: (.*?)\s*\(([^()]+)\)\s*$/;
const TS = /^Message[ _][Tt][Ss]: (\d+\.\d+)\s*$/;
const THREAD = /^Thread: (\d+) repl(?:y|ies) \(latest: (.+?)\)\s*$/;
const SENT_USING = /^\*Sent using\*/;

type Draft = {
	authorId: string | null;
	authorName: string | null;
	ts: string | null;
	body: string[];
	sentViaApp: boolean;
	threadLatest: string | null;
	threadReplyCount: number | null;
};

const emptyDraft = (): Draft => ({
	authorId: null,
	authorName: null,
	ts: null,
	body: [],
	sentViaApp: false,
	threadLatest: null,
	threadReplyCount: null,
});

function flush(draft: Draft, out: SlackMessage[]): void {
	if (!draft.ts) return;
	out.push({
		ts: draft.ts,
		authorId: draft.authorId,
		authorName: draft.authorName,
		text: draft.body.join("\n").trim(),
		sentViaApp: draft.sentViaApp,
		threadLatest: draft.threadLatest,
		threadReplyCount: draft.threadReplyCount,
	});
}

/**
 * Parse `slack_read_channel` or `slack_read_thread` message text. Both use the
 * same record grammar with different headers.
 */
export function parseConversation(text: string): SlackMessage[] {
	const out: SlackMessage[] = [];
	let draft = emptyDraft();

	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		const line = raw.trimEnd();

		const inline = HEADER_INLINE.exec(line);
		if (inline) {
			flush(draft, out);
			draft = emptyDraft();
			draft.authorName = inline[1].trim() || null;
			draft.authorId = inline[2].trim() || null;
			continue;
		}

		if (HEADER_PARENT.test(line) || HEADER_REPLY.test(line)) {
			flush(draft, out);
			draft = emptyDraft();
			continue;
		}

		if (SECTION.test(line)) continue;

		const from = FROM.exec(line);
		if (from && !draft.ts) {
			draft.authorName = from[1].trim() || null;
			draft.authorId = from[2].trim() || null;
			continue;
		}

		const ts = TS.exec(line);
		if (ts) {
			draft.ts = ts[1];
			continue;
		}

		const thread = THREAD.exec(line);
		if (thread) {
			draft.threadReplyCount = Number(thread[1]);
			draft.threadLatest = thread[2].trim();
			continue;
		}

		if (SENT_USING.test(line)) {
			draft.sentViaApp = true;
			continue;
		}

		// Envelope preamble such as `Channel: DM (D0...)` precedes any record.
		if (draft.ts) draft.body.push(line);
	}

	flush(draft, out);
	return out;
}

const RESULT_SPLIT = /^### Result \d+ of \d+\s*$/m;
const HIT_CHANNEL = /^Channel:\s*(\S+)\s*\(ID: ([^)]+)\)/m;
const HIT_FROM = /^From:\s*(.*?)\s*\(ID: ([^)]+)\)/m;
const HIT_TIME = /^Time:\s*(.+)$/m;
const HIT_TS = /^Message_ts:\s*(\d+\.\d+)/m;
const HIT_PERMALINK = /^Permalink:\s*\[link\]\(([^)]+)\)/m;

/** Parse the `results` field of a `slack_search_*` response. */
export function parseSearchResults(text: string): SearchHit[] {
	const blocks = text.split(RESULT_SPLIT).slice(1);
	const hits: SearchHit[] = [];

	for (const block of blocks) {
		const ts = HIT_TS.exec(block);
		if (!ts) continue;

		const channel = HIT_CHANNEL.exec(block);
		const from = HIT_FROM.exec(block);
		const time = HIT_TIME.exec(block);
		const permalink = HIT_PERMALINK.exec(block);

		// Body runs from `Text:` to the context block or the record separator.
		const start = block.indexOf("\nText:");
		let body = "";
		if (start !== -1) {
			const rest = block.slice(start + "\nText:".length);
			const stop = rest.search(/\n(?:Context before:|Context after:|---\s*$)/m);
			body = (stop === -1 ? rest : rest.slice(0, stop)).trim();
		}

		hits.push({
			ts: ts[1],
			channelId: channel?.[2]?.trim() ?? null,
			channelName: channel?.[1]?.trim() ?? null,
			authorId: from?.[2]?.trim() ?? null,
			authorName: from?.[1]?.trim() || null,
			time: time?.[1]?.trim() ?? null,
			permalink: permalink?.[1]?.trim() ?? null,
			text: body,
		});
	}

	return hits;
}

export type Reaction = { emoji: string; count: number; userIds: string[] };

/**
 * `:+1: × 1 — confidence (U0BUM44636U)`
 *
 * Slack canonicalises emoji aliases, so a reaction added as `thumbsup` reads
 * back as `+1`. Callers must compare against normalised names.
 */
const REACTION_LINE = /^:([^:]+):\s*×\s*(\d+)\s*—\s*(.*)$/;
const REACTION_USER = /\(([^)]+)\)/g;

export function parseReactions(text: string): Reaction[] {
	const out: Reaction[] = [];

	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		const match = REACTION_LINE.exec(raw.trim());
		if (!match) continue;

		const userIds = [...match[3].matchAll(REACTION_USER)].map((m) => m[1].trim());
		out.push({ emoji: match[1], count: Number(match[2]), userIds });
	}

	return out;
}

/**
 * Confirm a permalink actually refers to the channel and timestamp it is
 * attached to. Slack permalinks encode the timestamp as `p<ts without dot>`.
 * Anything that fails this check is dropped rather than shown, so the model
 * cannot attach a plausible-looking link to the wrong message.
 */
export function permalinkMatches(
	permalink: string | null,
	channelId: string | null,
	ts: string,
): boolean {
	if (!permalink || !channelId) return false;
	const compact = ts.replace(".", "");
	return permalink.includes(`/${channelId}/`) && permalink.includes(`p${compact}`);
}
