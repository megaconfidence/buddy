import type { Reaction } from "./slack/parse";

/**
 * Reaction-based relevance feedback.
 *
 * Slack is already the interface, so the cheapest signal the owner can give is
 * a reaction on a briefing item. No new surface, and `slack_get_reactions` is
 * already in the read-only allowlist.
 */

export type Verdict = "useful" | "noise" | "none";

/**
 * Slack canonicalises aliases before storing them, so `thumbsup` comes back as
 * `+1`. Only normalised names appear here.
 */
const USEFUL = new Set([
	"+1",
	"heart",
	"fire",
	"tada",
	"star",
	"bookmark",
	"white_check_mark",
	"raised_hands",
]);

const NOISE = new Set(["-1", "x", "no_entry", "zzz", "mute", "wastebasket"]);

/**
 * Classify the owner's reactions on one briefing item.
 *
 * Reactions from anyone else are ignored. In a self-DM nobody else can react,
 * but the rule should not depend on where the message happens to live.
 * An explicit negative outranks a positive: saying "this was noise" is a
 * deliberate act and should not be cancelled out by a stray emoji.
 */
export function classifyReactions(
	reactions: Reaction[],
	ownerId: string,
): Verdict {
	let useful = false;
	let noise = false;

	for (const reaction of reactions) {
		if (!reaction.userIds.includes(ownerId)) continue;
		if (USEFUL.has(reaction.emoji)) useful = true;
		if (NOISE.has(reaction.emoji)) noise = true;
	}

	if (noise) return "noise";
	if (useful) return "useful";
	return "none";
}

export const PROMOTE_AT = 2;
export const DEMOTE_AT = -2;

/**
 * Decide what a term's accumulated score should do to the watchlist.
 *
 * Thresholds are deliberately small. The owner sees a handful of items a day,
 * so requiring many signals would mean the list never moves.
 */
export function watchlistAction(
	positive: number,
	negative: number,
): "promote" | "demote" | "hold" {
	const score = positive - negative;
	if (score >= PROMOTE_AT) return "promote";
	if (score <= DEMOTE_AT) return "demote";
	return "hold";
}
