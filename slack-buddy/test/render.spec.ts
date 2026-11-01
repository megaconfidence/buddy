import { describe, expect, it } from "vitest";
import { MAX_ITEMS } from "../src/digest/editorial";
import {
	MESSAGE_BUDGET,
	briefingTitle,
	fitBriefing,
	renderBriefing,
	renderQuiet,
} from "../src/digest/render";
import { SECTIONS, emptyStats, type Briefing, type BriefingItem, type BriefingSource, type Section } from "../src/digest/types";
import { CHANNEL, NOW, SINCE, permalink, ts } from "./helpers";

const TZ = "Europe/London";
const ctx = {
	stats: { ...emptyStats(), messages: 412, channels: 14 },
	since: SINCE,
	now: NOW,
	timeZone: TZ,
	title: "Morning briefing",
};

const source = (channelName: string, n: number): BriefingSource => {
	const rootTs = ts(n);
	return { key: `${CHANNEL}:${rootTs}`, channelId: CHANNEL, channelName, rootTs, permalink: permalink(CHANNEL, rootTs), latestTs: rootTs };
};

function item(number: number, section: Section, text: string, extra: Partial<BriefingItem> = {}): BriefingItem {
	const rootTs = ts(number);
	return {
		number,
		section,
		text,
		isUpdate: false,
		certainty: null,
		when: null,
		nextStep: null,
		format: null,
		hook: null,
		whyNow: null,
		effort: null,
		sources: [
			{
				key: `${CHANNEL}:${rootTs}`,
				channelId: CHANNEL,
				channelName: "vibe",
				rootTs,
				permalink: permalink(CHANNEL, rootTs),
				latestTs: rootTs,
			},
		],
		terms: ["Vibe"],
		findingIds: ["F1"],
		...extra,
	};
}

const typical: Briefing = {
	tldr: "Vibe 2.0 GA moved to 19 Nov and the team wants a launch demo.",
	items: [
		item(1, "needs_you", "Alice asked you to review the OCR cookbook draft by Thursday"),
		item(2, "whats_new", "Vibe 2.0 GA moved from 12 to 19 Nov", { certainty: "tentative" }),
		item(3, "whats_new", "Le Chat Enterprise pricing page is live", { isUpdate: true, certainty: "confirmed" }),
		item(4, "opportunity", "AI Engineer Paris CFP closes Friday", { nextStep: "Draft a Vibe agents abstract" }),
		item(5, "content_idea", "Ship a coding agent with Vibe 2.0", {
			format: "video",
			effort: "medium",
			hook: "Zero to merged PR in ten minutes",
			whyNow: "GA on 19 Nov",
		}),
	],
};

describe("renderBriefing", () => {
	const text = renderBriefing(typical, ctx);

	it("is one scannable message with the four sections in order", () => {
		const headings = ["**Needs you**", "**What's new**", "**Opportunities**", "**Content ideas**"].map((h) => text.indexOf(h));
		expect(headings.every((i) => i > 0)).toBe(true);
		expect([...headings].sort((a, b) => a - b)).toEqual(headings);
		expect(text.startsWith("**Morning briefing · Thu 17 Sept**") || text.startsWith("**Morning briefing · Thu 17 Sep**")).toBe(true);
	});

	it("opens with the summary", () => {
		expect(text.split("\n\n")[1]).toBe(typical.tldr);
	});

	it("numbers every item so the owner can reply about it", () => {
		for (const i of typical.items) expect(text).toContain(`- **${i.number}** `);
	});

	it("links each item to its sources in the message itself", () => {
		for (const i of typical.items) expect(text).toContain(`[#vibe](${i.sources[0].permalink})`);
		expect(text.match(/\]\(https:\/\//g)).toHaveLength(typical.items.length);
	});

	it("labels what is unconfirmed or an update, and gives next steps and hooks", () => {
		expect(text).toContain("Vibe 2.0 GA moved from 12 to 19 Nov _(tentative)_ · [#vibe](");
		expect(text).toContain("_Update:_ Le Chat Enterprise pricing page is live · [#vibe](");
		expect(text).not.toContain("_(confirmed)_");
		expect(text).toContain("AI Engineer Paris CFP closes Friday. _Next: Draft a Vibe agents abstract_ · [#vibe](");
		expect(text).toContain(
			"**Ship a coding agent with Vibe 2.0** (video, medium effort) — Zero to merged PR in ten minutes. _Why now: GA on 19 Nov_ · [#vibe](",
		);
	});

	it("links at most two sources per item, one per channel", () => {
		const busy = item(1, "whats_new", "News", { sources: [source("vibe", 1), source("vibe", 2), source("launches", 3), source("events", 4)] });
		const line = renderBriefing({ tldr: "", items: [busy] }, ctx);
		expect(line).toContain(`· [#vibe](${permalink(CHANNEL, ts(1))}), [#launches](${permalink(CHANNEL, ts(3))})`);
		expect(line).not.toContain(permalink(CHANNEL, ts(2)));
		expect(line).not.toContain("#events");
	});

	it("names a source it cannot link, so nothing but a Slack permalink becomes a link", () => {
		const evil = item(1, "whats_new", "News");
		evil.sources[0].permalink = "https://evil.example/archives/C1/p1";
		const line = renderBriefing({ tldr: "", items: [evil] }, ctx);
		expect(line).not.toContain("evil.example");
		expect(line).toContain("- **1** News · #vibe");
	});

	it("says what it covered and how to reply", () => {
		expect(text).toContain("Read 412 messages across 14 channels since Wed 14:30");
		expect(text).toContain('Reply "more on 2", "2 useful" or "2 noise"');
		expect(text).not.toContain("thread");
	});

	it("omits empty sections", () => {
		const onlyNews = renderBriefing({ tldr: "", items: [item(1, "whats_new", "News")] }, ctx);
		expect(onlyNews).not.toContain("Needs you");
		expect(onlyNews).not.toContain("Content ideas");
	});
});

describe("fitBriefing", () => {
	const long = (n: number, section: Section) =>
		item(n, section, `${"Long item text ".repeat(14)}${n}`, {
			hook: section === "content_idea" ? "A hook ".repeat(20) : null,
			whyNow: section === "content_idea" ? "Timing ".repeat(12) : null,
		});

	const maxed: Briefing = {
		tldr: "Summary ".repeat(50),
		items: SECTIONS.flatMap((s) => Array.from({ length: MAX_ITEMS[s] }, () => s)).map((s, i) => long(i + 1, s)),
	};

	it("fits even a maximal briefing in one message", () => {
		const { text } = fitBriefing(maxed, ctx);
		expect(text.length).toBeLessThanOrEqual(MESSAGE_BUDGET);
	});

	it("keeps every ask, and renumbers what remains", () => {
		const { briefing } = fitBriefing(maxed, ctx);
		const needs = briefing.items.filter((i) => i.section === "needs_you");
		expect(needs).toHaveLength(MAX_ITEMS.needs_you);
		expect(briefing.items.map((i) => i.number)).toEqual(briefing.items.map((_, i) => i + 1));
	});

	it("trims the longest section first, so no section is emptied early", () => {
		const { briefing } = fitBriefing(maxed, ctx);
		const count = (s: Section) => briefing.items.filter((i) => i.section === s).length;
		expect(briefing.items.length).toBeLessThan(maxed.items.length);
		expect(Math.abs(count("whats_new") - count("opportunity"))).toBeLessThanOrEqual(1);
		expect(count("content_idea")).toBeGreaterThan(0);
	});

	it("drops to one link per item before dropping any item", () => {
		const linked: Briefing = {
			tldr: "",
			items: Array.from({ length: 14 }, (_, i) =>
				item(i + 1, "whats_new", `${"Story ".repeat(25)}${i}`, { sources: [source("vibe", i + 1), source("launches", i + 20)] }),
			),
		};
		expect(renderBriefing(linked, ctx).length).toBeGreaterThan(MESSAGE_BUDGET);

		const { briefing, text } = fitBriefing(linked, ctx);
		expect(briefing.items).toHaveLength(14);
		expect(text.length).toBeLessThanOrEqual(MESSAGE_BUDGET);
		expect(text.match(/\]\(https:\/\//g)).toHaveLength(14);
	});

	it("leaves a briefing that fits untouched", () => {
		const { briefing, text } = fitBriefing(typical, ctx);
		expect(briefing.items).toHaveLength(typical.items.length);
		expect(text).toBe(renderBriefing(typical, ctx));
	});
});

describe("renderQuiet", () => {
	it("says the run happened, and what it read", () => {
		expect(renderQuiet(ctx)).toMatch(/^\*\*Morning briefing · Thu 17 Sept?\*\* — nothing worth surfacing\.\n_Read 412 messages across 14 channels since Wed 14:30\._$/);
	});

	it("distinguishes an empty window from an uneventful one", () => {
		expect(renderQuiet({ ...ctx, stats: emptyStats() })).toContain("No new messages in your channels since Wed 14:30.");
	});
});

describe("briefingTitle", () => {
	it("calls a morning run the morning briefing, in the owner's timezone", () => {
		expect(briefingTitle(NOW, TZ)).toBe("Morning briefing");
		expect(briefingTitle(new Date(Date.UTC(2026, 8, 17, 15)), TZ)).toBe("Briefing");
	});
});
