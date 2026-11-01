import type { LanguageModel } from "ai";
import type { PreferenceProfile } from "../feedback";
import type { SlackClient } from "../slack/client";
import { buildQueryPlan, collectConversations, type TopicSignal } from "./collect";
import {
	composeBriefing,
	draftFromFindings,
	EMPTY_DRAFT,
	extractFindings,
	finalizeBriefing,
	type BriefingDraft,
	type PreviousItem,
} from "./editorial";
import type { DigestResult } from "./types";

export { SEARCH_BUDGET, buildQueryPlan, lastOwnerPosts, threadKey } from "./collect";
export type * from "./types";

/** How far back the editor looks to avoid repeating itself. */
const PREVIOUSLY_BRIEFED_DAYS = 5;

/** The state the digest reads. A structural subset of `Store`, so tests can fake it. */
export type DigestStore = {
	activeTopics(): string[];
	signals(): TopicSignal[];
	focusChannels(): Array<{ channelId: string; name: string }>;
	briefedLatest(key: string): number | undefined;
	recentBriefingItems(sinceMs: number): PreviousItem[];
	preferenceProfile(): PreferenceProfile;
	workspaceHost(): string | null;
	setWorkspaceHost(host: string): void;
};

/**
 * The daily digest: collect conversations, extract findings, edit one
 * briefing. Delivery and bookkeeping stay with the agent.
 */
export async function runDigest(opts: {
	client: Pick<SlackClient, "searchJoined" | "readChannel" | "readThread">;
	store: DigestStore;
	model: LanguageModel;
	ownerId: string;
	timeZone: string;
	since: Date;
	now?: Date;
}): Promise<DigestResult> {
	const now = opts.now ?? new Date();
	const watchlist = opts.store.activeTopics();
	const knownHost = opts.store.workspaceHost();

	const { candidates, stats, workspaceHost } = await collectConversations({
		client: opts.client,
		plan: buildQueryPlan({ ownerId: opts.ownerId, topics: watchlist, signals: opts.store.signals(), now }),
		ownerId: opts.ownerId,
		since: opts.since,
		watchlist,
		focusChannels: opts.store.focusChannels(),
		workspaceHost: knownHost,
		briefedLatest: (key) => opts.store.briefedLatest(key),
	});
	if (workspaceHost && workspaceHost !== knownHost) opts.store.setWorkspaceHost(workspaceHost);
	if (candidates.length === 0) return { status: "empty", stats };

	const profile = opts.store.preferenceProfile();
	const { findings, failedBatches } = await extractFindings({
		model: opts.model,
		candidates,
		ownerId: opts.ownerId,
		timeZone: opts.timeZone,
		watchlist,
		profile,
	});
	stats.findings = findings.length;
	stats.failedBatches = failedBatches;

	let draft: BriefingDraft = EMPTY_DRAFT;
	if (findings.length > 0) {
		try {
			draft = await composeBriefing({
				model: opts.model,
				findings,
				candidates,
				previouslyBriefed: opts.store.recentBriefingItems(now.getTime() - PREVIOUSLY_BRIEFED_DAYS * 86_400_000),
				watchlist,
				profile,
				timeZone: opts.timeZone,
			});
		} catch (error) {
			console.warn("Briefing editor failed; falling back to unedited findings", error);
			draft = draftFromFindings(findings);
		}
	}

	const briefing = finalizeBriefing(draft, findings, candidates, { ownerId: opts.ownerId });
	stats.surfaced = briefing.items.length;
	return briefing.items.length === 0 ? { status: "empty", stats } : { status: "ok", briefing, stats };
}
