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
	/** The gateway marks bot authors with `[BOT]` on the `From:` line. */
	isBot: boolean;
	/** Surrounding messages from `include_context`, flattened to `Name: text` lines. */
	context: string;
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
const HIT_FROM_LINE = /^From:.*$/m;
const HIT_TIME = /^Time:\s*(.+)$/m;
const HIT_TS = /^Message_ts:\s*(\d+\.\d+)/m;
const HIT_PERMALINK = /^Permalink:\s*\[link\]\(([^)]+)\)/m;
const CONTEXT_START = /\n(?:Context before:|Context after:)/;
const CONTEXT_FROM = /^- From:\s*(.*?)\s*\(ID: [^)]+\)\s*$/;

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
			isBot: /\[BOT\]/.test(HIT_FROM_LINE.exec(block)?.[0] ?? ""),
			context: parseContext(block),
		});
	}

	return hits;
}

/**
 * Flatten a hit's `Context before:` / `Context after:` blocks into
 * `Name: text` lines. Timestamps and user ids are dropped: the context is
 * only ever shown to the model, never linked.
 */
function parseContext(block: string): string {
	const start = block.search(CONTEXT_START);
	if (start === -1) return "";

	const entries: string[] = [];
	for (const raw of block.slice(start).split("\n")) {
		const line = raw.trim();
		if (!line || line === "---") continue;
		if (/^Context (?:before|after):$/i.test(line) || /^Message_ts:/i.test(line)) continue;

		const from = CONTEXT_FROM.exec(line);
		if (from) {
			entries.push(`${cleanAuthorName(from[1]) ?? "Someone"}:`);
		} else if (entries.length === 0) {
			entries.push(line);
		} else {
			entries[entries.length - 1] += ` ${line}`;
		}
	}
	return entries.join("\n");
}

/** `Ada Lovelace <ada@example.com>` → `Ada Lovelace`. Emails never reach the model. */
export function cleanAuthorName(name: string | null | undefined): string | null {
	const cleaned = (name ?? "").replace(/<[^>]*>/g, "").trim();
	return cleaned || null;
}

/**
 * Split a search response envelope into the rendered results and the
 * pagination cursor.
 *
 * The gateway puts the cursor in prose, in `pagination_info` (verified live
 * 2026-11-01). The other usual places are checked too, in case that changes;
 * a missing cursor only means the caller stops after one page.
 */
export function parseSearchEnvelope(raw: string): {
	results: string;
	nextCursor: string | null;
} {
	let results = raw;
	let cursor: string | null = null;
	try {
		const envelope = JSON.parse(raw) as Record<string, unknown>;
		if (typeof envelope.results === "string") results = envelope.results;

		const metadata = envelope.response_metadata as Record<string, unknown> | undefined;
		for (const candidate of [envelope.next_cursor, envelope.nextCursor, envelope.cursor, metadata?.next_cursor]) {
			if (typeof candidate === "string" && candidate.trim()) {
				cursor = candidate.trim();
				break;
			}
		}
		if (!cursor) {
			for (const [key, value] of Object.entries(envelope)) {
				if (key === "results" || typeof value !== "string") continue;
				cursor = cursorFromText(value, true);
				if (cursor) break;
			}
		}
	} catch {
		// Not JSON: the whole payload is the rendered text.
	}
	return { results, nextCursor: cursor ?? cursorFromText(results) };
}

/**
 * The gateway's `pagination_info` reads "For the next page of results use
 * cursor `<cursor>`" (observed live, 2026-11-01). A field other than the
 * results is metadata, so prose there can be trusted.
 */
const CURSOR_IN_PROSE = /\bcursor\b[^`\n]*`([^`\s]{4,})`/i;

/** In the results text only a line that is nothing but a cursor label counts, so message bodies cannot. */
const CURSOR_LINE = /^\W*next[_ ]?cursor\W*[:=]\s*`?([A-Za-z0-9+/=_-]{6,})`?\s*$/im;

function cursorFromText(text: string, metadata = false): string | null {
	return (metadata ? CURSOR_IN_PROSE.exec(text)?.[1] : undefined) ?? CURSOR_LINE.exec(text)?.[1] ?? null;
}

/** UTC offsets in minutes for the abbreviations the gateway renders. */
const ZONE_OFFSETS: Record<string, number> = {
	UTC: 0,
	GMT: 0,
	BST: 60,
	CET: 60,
	CEST: 120,
	EET: 120,
	EEST: 180,
	EST: -300,
	EDT: -240,
	CST: -360,
	CDT: -300,
	MST: -420,
	MDT: -360,
	PST: -480,
	PDT: -420,
};

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*([A-Z]{2,5}|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a gateway-rendered time such as `2026-09-17 20:47:14 BST` to epoch
 * milliseconds. Returns null for anything ambiguous: a guessed offset could
 * silently skip or resurrect a thread.
 */
export function parseSlackLocalTime(value: string | null | undefined): number | null {
	const match = LOCAL_TIME.exec((value ?? "").trim());
	if (!match) return null;

	const [, y, mo, d, h, mi, s, zone] = match;
	let offset: number | undefined = ZONE_OFFSETS[zone];
	if (offset === undefined) {
		const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
		if (!numeric) return null;
		offset = (numeric[1] === "-" ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3]));
	}
	const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"));
	return utc - offset * 60_000;
}

/**
 * Confirm a permalink actually refers to the channel and timestamp it is
 * attached to. Slack permalinks encode the timestamp as `p<ts without dot>`.
 * Anything that fails this check is dropped rather than shown, so the model
 * cannot attach a plausible-looking link to the wrong message.
 */
export function permalinkMatches(permalink: string | null, channelId: string | null, ts: string): boolean {
	if (!permalink || !channelId) return false;
	const compact = ts.replace(".", "");
	return permalink.includes(`/${channelId}/`) && permalink.includes(`p${compact}`);
}

/**
 * A Slack workspace host: `acme.slack.com`, or on Enterprise Grid
 * `acme.enterprise.slack.com`. Mistral's workspace is the latter.
 */
const SLACK_HOST = /^(?:[a-z0-9-]+\.)+slack\.com$/i;

const SLACK_PERMALINK = /^https:\/\/(?:[a-z0-9-]+\.)+slack\.com\/archives\/[A-Z0-9]+\/p\d+(?:\?[\w=&.%-]*)?$/i;

/**
 * Whether a URL is a Slack message permalink and nothing else. Checked again
 * just before a link is rendered, so nothing but a permalink from our own
 * records can become a link, and nothing in it can break Markdown link syntax.
 */
export function isSlackPermalink(url: string | null | undefined): url is string {
	return typeof url === "string" && SLACK_PERMALINK.test(url);
}

/** The workspace host of a Slack permalink, e.g. `acme.enterprise.slack.com`. */
export function workspaceHostOf(permalink: string | null): string | null {
	if (!permalink) return null;
	try {
		const url = new URL(permalink);
		return url.protocol === "https:" && SLACK_HOST.test(url.host) ? url.host : null;
	} catch {
		return null;
	}
}

/**
 * Build a permalink from ids the application already holds.
 *
 * Channel reads return no permalinks, so focus-channel conversations need
 * one constructed. Every input comes from our own records, never from the
 * model, which keeps the "the model never supplies a link" property.
 */
export function buildPermalink(host: string | null, channelId: string, ts: string): string | null {
	if (!host || !SLACK_HOST.test(host)) return null;
	if (!/^[A-Z0-9]+$/.test(channelId) || !/^\d+\.\d+$/.test(ts)) return null;
	return `https://${host}/archives/${channelId}/p${ts.replace(".", "")}`;
}
