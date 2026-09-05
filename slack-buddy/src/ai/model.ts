import { createMistral } from "@ai-sdk/mistral";
import { generateText, Output, type LanguageModel } from "ai";
import type { CandidateThread } from "../domain/threads";
import { rankingBatchSchema, structuredDigestSchema } from "../domain/schemas";
import type {
  RankedDigestItem,
  RelevanceProfile,
  StructuredDigest,
} from "../domain/types";
import { rankingPrompt, synthesisPrompt } from "./prompts";

export function createBuddyModel(env: {
  MISTRAL_API_KEY: string;
  MISTRAL_MODEL: string;
}): LanguageModel {
  return createMistral({ apiKey: env.MISTRAL_API_KEY })(env.MISTRAL_MODEL);
}

export async function rankThreads(
  model: LanguageModel,
  profile: RelevanceProfile,
  candidates: CandidateThread[],
): Promise<RankedDigestItem[]> {
  if (candidates.length === 0) return [];

  const result = await generateText({
    model,
    prompt: rankingPrompt(profile, candidates),
    output: Output.object({
      name: "buddy_thread_ranking",
      description: "Developer-advocacy relevance ranking for Slack threads",
      schema: rankingBatchSchema,
    }),
    temperature: 0.1,
    maxOutputTokens: 8_000,
    maxRetries: 2,
  });

  const sourcesByKey = new Map(
    candidates.flatMap(({ thread }) =>
      thread.messages.map((message) => [
        `${thread.channelId}:${thread.threadTs}:${message.messageTs}`,
        {
          channelId: thread.channelId,
          channelName: thread.channelName,
          threadTs: thread.threadTs,
          messageTs: message.messageTs,
        },
      ]),
    ),
  );
  const validItems = result.output.items
    .map((item) => ({
      ...item,
      sources: item.sources.flatMap((source) => {
        const canonical = sourcesByKey.get(
          `${source.channelId}:${source.threadTs}:${source.messageTs}`,
        );
        return canonical ? [canonical] : [];
      }),
    }))
    .filter((item) => item.sources.length > 0)
    .flatMap((item) => {
      if (representsMustShow(item, candidates)) {
        return [
          {
            ...item,
            relevance: 100,
            category: "needs_attention" as const,
            urgency: "today" as const,
            actionRequired: true,
          },
        ];
      }
      if (item.relevance >= profile.relevanceThreshold) return [item];
      if (item.relevance >= profile.borderlineThreshold) {
        return [{ ...item, category: "borderline" as const }];
      }
      return [];
    });

  const representedThreads = new Set(
    validItems.flatMap((item) =>
      item.sources.map((source) => `${source.channelId}:${source.threadTs}`),
    ),
  );
  const fallbacks = candidates
    .filter(
      ({ thread, mustShow }) =>
        mustShow &&
        !representedThreads.has(`${thread.channelId}:${thread.threadTs}`),
    )
    .map(fallbackMustShowItem);

  return [...validItems, ...fallbacks];
}

export async function synthesizeDigest(
  model: LanguageModel,
  profile: RelevanceProfile,
  rankedItems: RankedDigestItem[],
  totalThreadCount: number,
): Promise<StructuredDigest> {
  if (rankedItems.length === 0) {
    return {
      title: "Buddy briefing",
      overview:
        "No developer-advocacy items crossed your relevance threshold for this period.",
      items: [],
      omittedThreadCount: totalThreadCount,
    };
  }

  const result = await generateText({
    model,
    prompt: synthesisPrompt(profile, rankedItems, totalThreadCount),
    output: Output.object({
      name: "buddy_daily_digest",
      description: "A concise, source-grounded developer-advocacy briefing",
      schema: structuredDigestSchema,
    }),
    temperature: 0.1,
    maxOutputTokens: 8_000,
    maxRetries: 2,
  });

  const canonical = new Map(rankedItems.map((item) => [item.id, item]));
  const generatedItems = result.output.items
    .filter((item) => canonical.has(item.id))
    .map((item) => {
      const source = canonical.get(item.id);
      if (!source) return item;
      return {
        ...item,
        relevance: source.relevance,
        sources: source.sources,
      };
    });
  const generatedIds = new Set(generatedItems.map((item) => item.id));
  const missingMustShow = rankedItems.filter(
    (item) => item.relevance === 100 && !generatedIds.has(item.id),
  );
  const items = [...missingMustShow, ...generatedItems].slice(0, 15);

  return {
    ...result.output,
    items,
    omittedThreadCount: Math.max(0, totalThreadCount - items.length),
  };
}

function representsMustShow(
  item: RankedDigestItem,
  candidates: CandidateThread[],
): boolean {
  const mustShow = new Set(
    candidates
      .filter((candidate) => candidate.mustShow)
      .map(({ thread }) => `${thread.channelId}:${thread.threadTs}`),
  );
  return item.sources.some((source) =>
    mustShow.has(`${source.channelId}:${source.threadTs}`),
  );
}

function fallbackMustShowItem({ thread }: CandidateThread): RankedDigestItem {
  const first = thread.messages[0];
  if (!first) {
    throw new Error(`Must-show thread ${thread.id} contains no messages`);
  }

  const summary =
    first.text.length > 500 ? `${first.text.slice(0, 497)}...` : first.text;
  return {
    id: `must-show:${thread.channelId}:${thread.threadTs}`,
    relevance: 100,
    category: "needs_attention",
    urgency: "today",
    headline: "You were mentioned in a Slack thread",
    summary,
    whyRelevant: "The thread directly mentions you.",
    actionRequired: true,
    suggestedAction: "Open the source thread and respond if needed.",
    sources: [
      {
        channelId: thread.channelId,
        channelName: thread.channelName,
        threadTs: thread.threadTs,
        messageTs: first.messageTs,
      },
    ],
  };
}
