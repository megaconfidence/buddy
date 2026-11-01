import { describe, expect, it } from "vitest";
import {
	EMPTY_DRAFT,
	MAX_ITEMS,
	batchCandidates,
	canonicalizeFindings,
	cleanSlackText,
	draftFromFindings,
	finalizeBriefing,
	renderConversation,
	sanitizeText,
	type BriefingDraft,
} from "../src/digest/editorial";
import type { Finding } from "../src/digest/types";
import { OWNER, candidate, message, ts } from "./helpers";

const finding = (id: string, conversationKey: string, extra: Partial<Finding> = {}): Finding => ({
	id,
	conversationKey,
	kind: "planned",
	summary: `Summary of ${id}`,
	products: ["Vibe"],
	when: null,
	certainty: "tentative",
	forOwner: false,
	people: [],
	devrelValue: 70,
	contentValue: 60,
	...extra,
});

describe("sanitizeText", () => {
	it("removes links in every syntax the model could produce", () => {
		const text = sanitizeText("See [the docs](https://evil.example/x), <https://evil.example|here> and https://evil.example/y now", 200);
		expect(text).not.toMatch(/https?:|\]\(|<|>/);
		expect(text).toContain("the docs");
		expect(text).toContain("here");
	});

	it("stops Slack auto-linking a bare domain", () => {
		const text = sanitizeText("Sign in at evil.example/login", 200);
		expect(text).not.toContain("evil.example");
		expect(text.replace(/\u200B/g, "")).toContain("evil.example/login");
	});

	it("keeps version numbers intact", () => {
		expect(sanitizeText("Vibe 2.0 and Codestral 25.08", 200)).toBe("Vibe 2.0 and Codestral 25.08");
	});

	it("collapses to one line and drops Markdown that would break the list", () => {
		expect(sanitizeText("# **Big**\n\nnews", 200)).toBe("Big news");
	});

	it("truncates with an ellipsis", () => {
		expect(sanitizeText("a".repeat(50), 10)).toBe(`${"a".repeat(9)}…`);
	});
});

describe("cleanSlackText", () => {
	it("renders Slack markup readably and marks the owner", () => {
		const text = cleanSlackText(
			`<@${OWNER}> and <@U1|ada> see <#C1|launches> and <!subteam^S1|@devrel>: <https://docs.mistral.ai/x|the docs>, <!here>`,
			OWNER,
		);
		expect(text).toBe("@owner and @ada see #launches and @devrel: the docs (link), @here");
	});
});

describe("renderConversation", () => {
	it("marks context from before the window and labels the owner", () => {
		const c = candidate({
			messages: [message(ts(-60), "U1", "Earlier plan"), message(ts(10), OWNER, "Thoughts?"), message(ts(20), "U2", "Ship it")],
		});
		const text = renderConversation(c, "T1", { ownerId: OWNER, timeZone: "Europe/London" });
		const lines = text.split("\n");
		expect(lines[0]).toContain('id="T1"');
		expect(lines[1]).toMatch(/^\[earlier\] .* Person U1: Earlier plan$/);
		expect(lines[2]).toMatch(/OWNER: Thoughts\?$/);
		expect(lines[3]).not.toContain("[earlier]");
	});

	it("treats messages already briefed as context", () => {
		const c = candidate({
			messages: [message(ts(10), "U1", "GA on 19 Nov"), message(ts(30), "U2", "GA slips to 26 Nov")],
			briefedLatest: Number(ts(10)),
		});
		const text = renderConversation(c, "T1", { ownerId: OWNER, timeZone: "Europe/London" });
		expect(text).toContain('previously_briefed="yes"');
		expect(text.split("\n")[1]).toMatch(/^\[earlier\]/);
		expect(text.split("\n")[2]).not.toMatch(/^\[earlier\]/);
	});

	it("keeps the root and the newest replies of a long thread", () => {
		const messages = [message(ts(1), "U1", "Root of a very long thread")];
		for (let i = 2; i < 200; i++) messages.push(message(ts(i), "U2", `Reply ${i} ${"x".repeat(80)}`));
		const text = renderConversation(candidate({ messages }), "T1", { ownerId: OWNER, timeZone: "Europe/London" });
		expect(text.length).toBeLessThan(7_000);
		expect(text).toContain("Root of a very long thread");
		expect(text).toContain("Reply 199");
		expect(text).toMatch(/\[… \d+ messages omitted\]/);
	});
});

describe("batchCandidates", () => {
	it("splits large inputs while keeping ids unique", () => {
		const candidates = Array.from({ length: 40 }, (_, i) => candidate({ rootTs: ts(i + 1) }));
		const batches = batchCandidates(candidates, (_, id) => id);
		expect(batches.length).toBeGreaterThan(1);
		const ids = batches.flat().map((b) => b.id);
		expect(new Set(ids).size).toBe(40);
	});
});

describe("canonicalizeFindings", () => {
	const c = candidate();
	const raw = (extra: Record<string, unknown> = {}) => ({
		conversation: "T1",
		kind: "planned" as const,
		summary: "Vibe 2.0 GA moves to 19 Nov",
		products: ["Vibe"],
		when: "19 Nov",
		certainty: "tentative" as const,
		forOwner: false,
		people: ["Ada"],
		devrelValue: 80,
		contentValue: 70,
		...extra,
	});

	it("drops findings that cite a conversation outside the batch", () => {
		expect(canonicalizeFindings([raw({ conversation: "T9" })], new Map([["T1", c]]))).toHaveLength(0);
	});

	it("maps the batch id back to our own conversation key", () => {
		const [f] = canonicalizeFindings([raw()], new Map([["T1", c]]));
		expect(f.conversationKey).toBe(c.key);
	});

	it("drops low-value findings unless they concern the owner", () => {
		const byId = new Map([["T1", c]]);
		expect(canonicalizeFindings([raw({ devrelValue: 5, contentValue: 5 })], byId)).toHaveLength(0);
		expect(canonicalizeFindings([raw({ devrelValue: 5, contentValue: 5, forOwner: true })], byId)).toHaveLength(1);
	});

	it("clamps scores and de-duplicates", () => {
		const out = canonicalizeFindings([raw({ devrelValue: 400 }), raw()], new Map([["T1", c]]));
		expect(out).toHaveLength(1);
		expect(out[0].devrelValue).toBe(100);
	});
});

describe("finalizeBriefing", () => {
	const a = candidate({ rootTs: ts(10) });
	const b = candidate({ rootTs: ts(20), channelName: "launches", terms: ["launch"] });
	const findings = [finding("F1", a.key), finding("F2", b.key)];

	it("numbers items across sections in display order", () => {
		const draft: BriefingDraft = {
			...EMPTY_DRAFT,
			tldr: "Big week for Vibe.",
			contentIdeas: [{ title: "Ship a coding agent", format: "video", hook: "Zero to PR", whyNow: "GA soon", effort: "medium", findings: ["F1"] }],
			whatsNew: [{ text: "Vibe GA moves", isUpdate: false, certainty: "confirmed", findings: ["F1"] }],
			needsYou: [{ text: "Review the demo", findings: ["F2"] }],
		};
		const briefing = finalizeBriefing(draft, findings, [a, b], { ownerId: OWNER });
		expect(briefing.items.map((i) => [i.number, i.section])).toEqual([
			[1, "needs_you"],
			[2, "whats_new"],
			[3, "content_idea"],
		]);
	});

	it("attaches sources from our records and merges across channels", () => {
		const draft: BriefingDraft = { ...EMPTY_DRAFT, whatsNew: [{ text: "Vibe GA moves", isUpdate: false, certainty: "confirmed", findings: ["F1", "F2"] }] };
		const [item] = finalizeBriefing(draft, findings, [a, b], { ownerId: OWNER }).items;
		expect(item.sources.map((s) => s.permalink)).toEqual([a.permalink, b.permalink]);
		expect(item.terms).toEqual(["Vibe", "launch"]);
	});

	it("drops items citing no real finding", () => {
		const draft: BriefingDraft = { ...EMPTY_DRAFT, whatsNew: [{ text: "Invented", isUpdate: false, certainty: "confirmed", findings: ["F99"] }] };
		expect(finalizeBriefing(draft, findings, [a, b], { ownerId: OWNER }).items).toHaveLength(0);
	});

	it("caps each section", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ text: `News ${i}`, isUpdate: false, certainty: "confirmed" as const, findings: ["F1"] }));
		const items = finalizeBriefing({ ...EMPTY_DRAFT, whatsNew: many }, findings, [a, b], { ownerId: OWNER }).items;
		expect(items).toHaveLength(MAX_ITEMS.whats_new);
	});

	it("puts back a direct mention the model left out", () => {
		const mention = candidate({
			rootTs: ts(30),
			messages: [message(ts(30), "U7", `<@${OWNER}> can you review the OCR cookbook by Thursday?`)],
			assessment: { status: "keep", mentionsOwner: true, awaitingOwner: false, newMessages: 1, participants: 1, latestOtherTs: 0 },
		});
		const briefing = finalizeBriefing(EMPTY_DRAFT, findings, [a, b, mention], { ownerId: OWNER });
		expect(briefing.items).toHaveLength(1);
		expect(briefing.items[0].section).toBe("needs_you");
		// The rendered line names the channel, so the text does not repeat it,
		// and the leading mention is dropped from the quote.
		expect(briefing.items[0].text).toBe('Person U7 mentioned you: "can you review the OCR cookbook by Thursday?"');
		expect(briefing.items[0].sources[0].permalink).toBe(mention.permalink);
	});

	it("does not duplicate a mention the model already covered", () => {
		const mention = candidate({
			rootTs: ts(30),
			assessment: { status: "keep", mentionsOwner: true, awaitingOwner: false, newMessages: 1, participants: 1, latestOtherTs: 0 },
		});
		const f = finding("F3", mention.key, { forOwner: true });
		const draft: BriefingDraft = { ...EMPTY_DRAFT, needsYou: [{ text: "Review the cookbook", findings: ["F3"] }] };
		expect(finalizeBriefing(draft, [...findings, f], [a, b, mention], { ownerId: OWNER }).items).toHaveLength(1);
	});

	it("falls back to the first item when the model wrote no summary", () => {
		const draft: BriefingDraft = { ...EMPTY_DRAFT, whatsNew: [{ text: "Vibe GA moves", isUpdate: false, certainty: "confirmed", findings: ["F1"] }] };
		expect(finalizeBriefing(draft, findings, [a, b], { ownerId: OWNER }).tldr).toBe("Vibe GA moves");
	});
});

describe("draftFromFindings", () => {
	it("sorts findings into sections without the model", () => {
		const draft = draftFromFindings([
			finding("F1", "k1", { kind: "shipped" }),
			finding("F2", "k2", { kind: "ask", forOwner: true }),
			finding("F3", "k3", { kind: "event" }),
		]);
		expect(draft.needsYou.map((i) => i.findings)).toEqual([["F2"]]);
		expect(draft.whatsNew.map((i) => i.findings)).toEqual([["F1"]]);
		expect(draft.opportunities.map((i) => i.findings)).toEqual([["F3"]]);
		expect(draft.contentIdeas).toEqual([]);
	});
});
