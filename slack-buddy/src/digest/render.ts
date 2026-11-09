import { isSlackPermalink } from "../slack/parse";
import {
	SECTIONS,
	type Briefing,
	type BriefingItem,
	type BriefingSource,
	type ContentFormat,
	type DigestStats,
	type Section,
} from "./types";

/**
 * Rendering for Slack's MCP `slack_send_message`, which takes standard
 * Markdown and caps a message at 5,000 characters.
 *
 * The briefing is one message: scannable top to bottom, numbered so the
 * owner can reply about any item, each item linking the conversations it came
 * from. Slack may preview those links; the owner prefers links in place.
 */

/** Below the 5,000 limit, leaving room for the gateway's attribution suffix. */
export const MESSAGE_BUDGET = 4_500;

/**
 * Sources linked per item, one per channel. An Enterprise Grid permalink is
 * about 120 characters, so links are the first thing to give way when a
 * briefing runs long; every source stays reachable through "more on N".
 */
export const LINKS_PER_ITEM = 2;

const HEADINGS: Record<Section, string> = {
	needs_you: "Needs you",
	whats_new: "What's new",
	opportunity: "Opportunities",
	content_idea: "Content ideas",
};

const FORMAT_LABELS: Record<ContentFormat, string> = {
	social_post: "social post",
	blog: "blog post",
	tutorial: "tutorial",
	cookbook: "cookbook",
	demo_app: "demo app",
	video: "video",
	talk: "talk",
	livestream: "livestream",
};

export type RenderContext = {
	stats: DigestStats;
	since: Date;
	now: Date;
	timeZone: string;
	title: string;
	/** Shown under the title, e.g. why this is a catch-up. */
	note?: string;
	/** Shown last, e.g. a focus-channel suggestion. */
	tip?: string;
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function formatDay(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(date);
}

/** `Mon 08:30` within the week, `28 Oct 08:30` beyond it. */
export function formatSince(since: Date, now: Date, timeZone: string): string {
	const recent = now.getTime() - since.getTime() < 6 * 86_400_000;
	return new Intl.DateTimeFormat("en-GB", {
		timeZone,
		...(recent ? { weekday: "short" } : { day: "numeric", month: "short" }),
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(since);
}

/** A morning run is the morning briefing; anything later is just a briefing. */
export function briefingTitle(now: Date, timeZone: string): string {
	const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(now));
	return hour < 12 ? "Morning briefing" : "Briefing";
}

/** `Morning briefing · Mon 9 Nov`: how a briefing message, and its notification, opens. */
function heading(opts: { title: string; now: Date; timeZone: string }): string {
	return `${opts.title} · ${formatDay(opts.now, opts.timeZone)}`;
}

const channelLabel = (s: BriefingSource) => (s.channelName ? `#${s.channelName.replace(/[^a-z0-9_-]/gi, "")}` : "thread");

/** End a fragment as a sentence, so an italic note after it does not run on. */
const sentence = (text: string) => (/[.!?…"”)]$/.test(text) ? text : `${text}.`);

/**
 * The item's sources as Markdown links, one per channel. Every URL comes from
 * our own records and is checked again here, so nothing else can become a
 * link; a source without a valid permalink is named but not linked.
 */
function sourceLinks(item: BriefingItem, maxLinks: number): string {
	const byChannel = new Map<string, BriefingSource>();
	for (const source of item.sources) {
		const label = channelLabel(source);
		if (!byChannel.has(label)) byChannel.set(label, source);
	}
	return [...byChannel]
		.slice(0, maxLinks)
		.map(([label, s]) => (isSlackPermalink(s.permalink) ? `[${label}](${s.permalink})` : label))
		.join(", ");
}

function renderItem(item: BriefingItem, maxLinks: number): string {
	const links = sourceLinks(item, maxLinks);
	const suffix = links ? ` · ${links}` : "";
	// A plain line led by a bold number, not a Markdown list. Slack turns a
	// list into a block of its own: bullets appear in front of the numbers,
	// and no blank line survives after it, so a section runs into the next
	// heading. Plain lines keep their line breaks and blank lines.
	const n = `**${item.number}.**`;

	switch (item.section) {
		case "needs_you":
			return `${n} ${item.text}${suffix}`;
		case "whats_new": {
			const update = item.isUpdate ? "_Update:_ " : "";
			const certainty = item.certainty && item.certainty !== "confirmed" ? ` _(${item.certainty})_` : "";
			return `${n} ${update}${item.text}${certainty}${suffix}`;
		}
		case "opportunity": {
			const text = item.nextStep ? `${sentence(item.text)} _Next: ${item.nextStep}_` : item.text;
			return `${n} ${text}${suffix}`;
		}
		case "content_idea": {
			const meta = [item.format ? FORMAT_LABELS[item.format] : null, item.effort ? `${item.effort} effort` : null]
				.filter(Boolean)
				.join(", ");
			const hook = item.hook ? ` — ${item.whyNow ? sentence(item.hook) : item.hook}` : "";
			const why = item.whyNow ? ` _Why now: ${item.whyNow}_` : "";
			return `${n} **${item.text}**${meta ? ` (${meta})` : ""}${hook}${why}${suffix}`;
		}
	}
}

/** Said whenever a search failed, so a thin briefing is not mistaken for a quiet day. */
function partial(s: DigestStats): string {
	return s.failedSearches > 0 ? ` ${s.failedSearches} of ${s.searches} searches failed, so coverage is partial.` : "";
}

function footer(briefing: Briefing, ctx: RenderContext): string {
	const s = ctx.stats;
	const n = briefing.items.length >= 2 ? 2 : 1;
	return `_Read ${plural(s.messages, "message")} across ${plural(s.channels, "channel")} since ${formatSince(ctx.since, ctx.now, ctx.timeZone)}.${partial(s)} Reply "more on ${n}", "${n} useful" or "${n} noise"._`;
}

export function renderBriefing(briefing: Briefing, ctx: RenderContext, maxLinks = LINKS_PER_ITEM): string {
	const parts = [`**${heading(ctx)}**`];
	if (ctx.note) parts.push(`_${ctx.note}_`);
	if (briefing.tldr) parts.push(briefing.tldr);

	for (const section of SECTIONS) {
		const items = briefing.items.filter((i) => i.section === section);
		if (items.length > 0) parts.push([`**${HEADINGS[section]}**`, ...items.map((i) => renderItem(i, maxLinks))].join("\n"));
	}

	parts.push(footer(briefing, ctx));
	if (ctx.tip) parts.push(`_${ctx.tip}_`);
	return parts.join("\n\n");
}

/** Tie-break when trimming: the least urgent section gives way first. */
const DROP_ORDER: Section[] = ["whats_new", "opportunity", "content_idea", "needs_you"];

function renumber(briefing: Briefing): Briefing {
	return { ...briefing, items: briefing.items.map((item, i) => ({ ...item, number: i + 1 })) };
}

/**
 * The item to drop next: the last of the longest section, so trimming keeps
 * the briefing balanced instead of emptying one section. "Needs you" goes
 * last, since those are asks waiting on the owner.
 */
function pickVictim(items: BriefingItem[]): BriefingItem | undefined {
	const groups = DROP_ORDER.map((s) => items.filter((i) => i.section === s));
	const others = groups.slice(0, -1);
	const longest = others.filter((g) => g.length > 1).sort((a, b) => b.length - a.length)[0];
	return (longest ?? others.find((g) => g.length > 0) ?? groups.at(-1))?.at(-1);
}

/**
 * Render within the message budget. Links go first: one per item instead of
 * two. Then the least urgent items are dropped until it fits. Returns the
 * briefing as actually shown, so stored item numbers match the message the
 * owner reads.
 */
export function fitBriefing(briefing: Briefing, ctx: RenderContext, budget = MESSAGE_BUDGET): { briefing: Briefing; text: string } {
	let current = renumber(briefing);
	for (const links of [LINKS_PER_ITEM, 1]) {
		const text = renderBriefing(current, ctx, links);
		if (text.length <= budget) return { briefing: current, text };
	}

	let text = renderBriefing(current, ctx, 1);
	while (text.length > budget && current.items.length > 1) {
		const victim = pickVictim(current.items);
		if (!victim) break;
		current = renumber({ ...current, items: current.items.filter((i) => i !== victim) });
		text = renderBriefing(current, ctx, 1);
	}

	if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;
	return { briefing: current, text };
}

/** Quiet days get one line, not silence: silence reads as a broken agent. */
export function renderQuiet(ctx: RenderContext): string {
	const s = ctx.stats;
	const since = formatSince(ctx.since, ctx.now, ctx.timeZone);
	const detail =
		(s.messages === 0
			? `No new messages in your channels since ${since}.`
			: `Read ${plural(s.messages, "message")} across ${plural(s.channels, "channel")} since ${since}.`) + partial(s);
	const note = ctx.note ? `\n_${ctx.note}_` : "";
	return `**${heading(ctx)}** — nothing worth surfacing.${note}\n_${detail}_`;
}

/** A briefing that did not go out, as told to the owner. */
export type FailureNotice = {
	title: string;
	now: Date;
	timeZone: string;
	reason: string;
	/** When the next attempt runs; null once retries are used up. */
	retryAt: Date | null;
	repeated: boolean;
	/** Slack can't be reached, so the catch-up waits for it rather than for a set time. */
	awaitingSlack?: boolean;
};

function nextStep(notice: FailureNotice): string {
	if (notice.awaitingSlack) return "I'll catch up once it's back.";
	if (!notice.retryAt) return `Tomorrow's briefing will cover today too, or reply "briefing" to try now.`;
	const at = new Intl.DateTimeFormat("en-GB", { timeZone: notice.timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
		notice.retryAt,
	);
	return `I'll try again at ${at}.`;
}

function failureDetail(notice: FailureNotice): string {
	return `${notice.repeated ? "still didn't" : "didn't"} go out: ${notice.reason}. ${nextStep(notice)}`;
}

/**
 * The notice for a briefing that did not go out. Silence is what hid the
 * October outage for eight weekdays; one short line costs nothing.
 */
export function renderFailure(notice: FailureNotice): string {
	return `**${heading(notice)}** ${failureDetail(notice)}`;
}

// Notifications are plain text: they are read in a phone's notification, and
// the workflow that sends them inserts them into a message of its own.

/** Says whether anything needs the owner before the summary. */
export function briefingNotification(briefing: Briefing, ctx: RenderContext): string {
	const asks = briefing.items.filter((i) => i.section === "needs_you").length;
	const counts = plural(briefing.items.length, "item") + (asks > 0 ? `, ${asks} ${asks === 1 ? "needs" : "need"} you` : "");
	return `${heading(ctx)}: ${counts}.${briefing.tldr ? ` ${briefing.tldr}` : ""}`;
}

export function quietNotification(ctx: RenderContext): string {
	return `${heading(ctx)}: nothing worth surfacing.`;
}

export function failureNotification(notice: FailureNotice): string {
	return `${heading(notice)} ${failureDetail(notice)}`;
}

/** The closing tip suggesting a focus channel. */
export function focusTip(channel: { name: string | null; briefings: number; useful: number }): string {
	const name = `#${(channel.name ?? "").replace(/[^a-z0-9_-]/gi, "")}`;
	const why =
		channel.useful > 0
			? `${plural(channel.useful, "item")} you found useful came from ${name}`
			: `${name} fed ${channel.briefings} of your recent briefings`;
	return `Tip: ${why}. Reply "focus on ${name}" to read it in full every morning.`;
}

/** The line explaining a catch-up, under the briefing's title. */
export function catchUpNote(missed: { firstFailedAt: number; reason: string }, now: Date, timeZone: string): string {
	return `Catching up: briefings haven't gone out since ${formatSince(new Date(missed.firstFailedAt), now, timeZone)} (${missed.reason}).`;
}

/** Per-stage counts for the run ledger, so an empty briefing says which stage produced nothing. */
export function describeStats(s: DigestStats): string {
	return [
		`searches=${s.searches}`,
		`failed_searches=${s.failedSearches}`,
		`reads=${s.reads}`,
		`messages=${s.messages}`,
		`conversations=${s.conversations}`,
		`engaged=${s.engaged}`,
		`briefed_before=${s.briefedBefore}`,
		`candidates=${s.candidates}`,
		`findings=${s.findings}`,
		`surfaced=${s.surfaced}`,
		`failed_batches=${s.failedBatches}`,
	].join(" ");
}
