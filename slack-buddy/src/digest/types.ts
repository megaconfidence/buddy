/**
 * Types shared by the digest pipeline.
 *
 * The pipeline mirrors changelog-buddy: collect evidence deterministically,
 * have the model evaluate it in batches (findings), then synthesise one
 * briefing from the findings. Slack evidence is conversational rather than a
 * stream of discrete change events, so the unit of evidence is a
 * conversation: a thread, or a top-level message that started none.
 */

export type ConversationMessage = {
	ts: string;
	authorId: string | null;
	authorName: string | null;
	text: string;
	isBot: boolean;
	/** Returned by the owner-mention search, whatever form the mention renders in. */
	mentionsOwner?: boolean;
};

export type Conversation = {
	/** `channel:root_ts`, the same key a search hit's permalink resolves to. */
	key: string;
	channelId: string;
	channelName: string | null;
	rootTs: string;
	/** From our own records; never produced by the model. */
	permalink: string | null;
	/** Chronological, unique by ts. */
	messages: ConversationMessage[];
	/** Search context lines, shown to the model only when the thread was not read. */
	context: string;
	/** What surfaced it: `@mentions`, `@you`, `focus`, watchlist topics, signal terms. */
	terms: string[];
	/** A thread read could add messages not yet seen. */
	expandable: boolean;
	expanded: boolean;
	/** Newest activity known before any thread read, epoch seconds. */
	activityTs: number;
};

export type AssessmentStatus =
	| "keep"
	/** Only the owner has posted. */
	| "own"
	/** The owner posted after everyone else: already read and answered. */
	| "engaged"
	/** Already briefed and nothing has happened since. */
	| "briefed"
	/** Nothing new in the window. */
	| "stale"
	/** Only bots have posted. */
	| "bots"
	/** The new messages carry no content, e.g. "thanks!". */
	| "trivial";

export type Assessment = {
	status: AssessmentStatus;
	/** Someone mentioned the owner and the owner has not posted since. */
	mentionsOwner: boolean;
	/** The owner posted, and someone else posted after them. */
	awaitingOwner: boolean;
	newMessages: number;
	participants: number;
	/** Newest message by someone other than the owner, epoch seconds. */
	latestOtherTs: number;
};

export type Candidate = Conversation & {
	assessment: Assessment;
	score: number;
	/** Messages at or before this ts were already briefed and are shown as context. */
	briefedLatest: number;
	/** Start of the briefing window, epoch seconds. */
	sinceSec: number;
};

export const FINDING_KINDS = ["ask", "shipped", "planned", "decision", "feedback", "event", "content"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const CERTAINTIES = ["confirmed", "tentative", "speculative"] as const;
export type Certainty = (typeof CERTAINTIES)[number];

/** One fact the map pass extracted from one conversation. */
export type Finding = {
	id: string;
	conversationKey: string;
	kind: FindingKind;
	summary: string;
	products: string[];
	when: string | null;
	certainty: Certainty;
	forOwner: boolean;
	people: string[];
	devrelValue: number;
	contentValue: number;
};

export const SECTIONS = ["needs_you", "whats_new", "opportunity", "content_idea"] as const;
export type Section = (typeof SECTIONS)[number];

export const CONTENT_FORMATS = ["social_post", "blog", "tutorial", "cookbook", "demo_app", "video", "talk", "livestream"] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export type BriefingSource = {
	key: string;
	channelId: string;
	channelName: string | null;
	rootTs: string;
	permalink: string | null;
	/** Newest message in the conversation when briefed, so a repeat can be detected. */
	latestTs: string;
};

export type BriefingItem = {
	/** Position across the whole message, so the owner can reply "more on 3". */
	number: number;
	section: Section;
	/** The line shown. For a content idea, its working title. */
	text: string;
	isUpdate: boolean;
	certainty: Certainty | null;
	when: string | null;
	nextStep: string | null;
	format: ContentFormat | null;
	hook: string | null;
	whyNow: string | null;
	effort: Effort | null;
	sources: BriefingSource[];
	/** Query terms behind the sources; feedback on the item is credited to them. */
	terms: string[];
	findingIds: string[];
};

export type Briefing = {
	tldr: string;
	items: BriefingItem[];
};

/** Per-stage counts, so an empty briefing says which stage produced nothing. */
export type DigestStats = {
	searches: number;
	reads: number;
	/** Unique messages seen across searches and reads. */
	messages: number;
	/** Conversations before filtering. */
	conversations: number;
	/** Dropped because the owner had already engaged. */
	engaged: number;
	/** Dropped because they were briefed before and nothing has changed. */
	briefedBefore: number;
	/** Conversations handed to the model. */
	candidates: number;
	channels: number;
	findings: number;
	surfaced: number;
	failedBatches: number;
};

export type DigestResult =
	| { status: "empty"; stats: DigestStats }
	| { status: "ok"; briefing: Briefing; stats: DigestStats };

export const emptyStats = (): DigestStats => ({
	searches: 0,
	reads: 0,
	messages: 0,
	conversations: 0,
	engaged: 0,
	briefedBefore: 0,
	candidates: 0,
	channels: 0,
	findings: 0,
	surfaced: 0,
	failedBatches: 0,
});
