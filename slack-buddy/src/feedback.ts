import type { BriefingItem, ContentFormat, Section } from "./digest/types";

/**
 * Relevance feedback.
 *
 * The briefing is one numbered message, so per-item reactions are gone. The
 * owner replies instead ("3 useful", "5 noise", "2 done"), and the agent
 * records the verdict with a tool. A verdict does two things, as in
 * changelog-buddy: it adds the item to a preference profile the model reads
 * on every run, and it scores the query terms that surfaced the item, which
 * promotes or drops them from the search plan.
 */

export type Verdict = "useful" | "noise" | "handled";

export type PreferenceProfile = {
	positiveExamples: string[];
	negativeExamples: string[];
	preferredFormats: ContentFormat[];
	version: number;
};

export const DEFAULT_PROFILE: PreferenceProfile = {
	positiveExamples: [],
	negativeExamples: [],
	preferredFormats: [],
	version: 1,
};

const MAX_EXAMPLES = 30;

const SECTION_LABELS: Record<Section, string> = {
	needs_you: "Needs you",
	whats_new: "What's new",
	opportunity: "Opportunity",
	content_idea: "Content idea",
};

export const exampleOf = (item: Pick<BriefingItem, "section" | "text">) => `${SECTION_LABELS[item.section]}: ${item.text}`.slice(0, 240);

const appendUnique = (values: string[], value: string) => [...values.filter((v) => v !== value), value].slice(-MAX_EXAMPLES);

/**
 * Fold a verdict into the profile. A later verdict on the same item replaces
 * an earlier one, so changing your mind does not leave the item on both
 * lists. `handled` records nothing: dealing with an item says nothing about
 * whether it was worth surfacing.
 */
export function applyVerdict(
	profile: PreferenceProfile,
	item: Pick<BriefingItem, "section" | "text" | "format">,
	verdict: Verdict,
): PreferenceProfile {
	if (verdict === "handled") return profile;

	const example = exampleOf(item);
	const useful = verdict === "useful";
	return {
		positiveExamples: useful ? appendUnique(profile.positiveExamples, example) : profile.positiveExamples.filter((e) => e !== example),
		negativeExamples: useful ? profile.negativeExamples.filter((e) => e !== example) : appendUnique(profile.negativeExamples, example),
		preferredFormats:
			useful && item.format && !profile.preferredFormats.includes(item.format)
				? [...profile.preferredFormats, item.format]
				: profile.preferredFormats,
		version: profile.version + 1,
	};
}

/** How a verdict moves the score of the terms that surfaced the item. */
export function termDirection(verdict: Verdict): "useful" | "noise" | null {
	return verdict === "handled" ? null : verdict;
}

/** Per channel: how many briefings it fed, and what the owner made of its items. */
export type ChannelTally = {
	channelId: string;
	name: string | null;
	briefings: number;
	useful: number;
	noise: number;
};

/** Briefings a channel must feed before it is suggested as a focus channel. */
export const SUGGEST_AFTER_BRIEFINGS = 3;
/** Or items from it the owner rated useful. */
export const SUGGEST_AFTER_USEFUL = 2;

export function tallyChannels(
	items: Array<{ runId: string; sources: Array<{ channelId: string; channelName: string | null }>; verdict: Verdict | null }>,
): ChannelTally[] {
	const tallies = new Map<string, ChannelTally & { runs: Set<string> }>();
	for (const item of items) {
		const channels = new Map(item.sources.map((s) => [s.channelId, s.channelName]));
		for (const [channelId, name] of channels) {
			const tally = tallies.get(channelId) ?? { channelId, name, briefings: 0, useful: 0, noise: 0, runs: new Set<string>() };
			tally.name ??= name;
			tally.runs.add(item.runId);
			if (item.verdict === "useful") tally.useful++;
			if (item.verdict === "noise") tally.noise++;
			tallies.set(channelId, tally);
		}
	}
	return [...tallies.values()].map(({ runs, ...tally }) => ({ ...tally, briefings: runs.size }));
}

/**
 * The channel most worth reading in full, if any: one that keeps feeding
 * briefings, or whose items the owner found useful, and whose items have not
 * been marked noise more often than useful. Search samples a channel; a focus
 * channel is read whole, so this is where coverage grows from evidence.
 */
export function suggestFocusChannel(tallies: ChannelTally[], opts: { exclude: ReadonlySet<string>; full: boolean }): ChannelTally | null {
	if (opts.full) return null;
	const score = (t: ChannelTally) => 2 * t.useful + t.briefings - 2 * t.noise;
	return (
		tallies
			.filter(
				(t) =>
					t.name !== null &&
					/^[CG][A-Z0-9]+$/.test(t.channelId) &&
					!opts.exclude.has(t.channelId) &&
					t.noise <= t.useful &&
					(t.briefings >= SUGGEST_AFTER_BRIEFINGS || t.useful >= SUGGEST_AFTER_USEFUL),
			)
			.sort((a, b) => score(b) - score(a))[0] ?? null
	);
}

export const PROMOTE_AT = 2;
export const DEMOTE_AT = -2;

/**
 * Decide what a term's accumulated score should do to the watchlist.
 *
 * Thresholds are deliberately small. The owner sees a handful of items a day,
 * so requiring many signals would mean the list never moves.
 */
export function watchlistAction(positive: number, negative: number): "promote" | "demote" | "hold" {
	const score = positive - negative;
	if (score >= PROMOTE_AT) return "promote";
	if (score <= DEMOTE_AT) return "demote";
	return "hold";
}
