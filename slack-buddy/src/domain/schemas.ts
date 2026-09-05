import { z } from "zod";

export const digestSourceSchema = z.object({
  channelId: z.string(),
  channelName: z.string().nullable(),
  threadTs: z.string(),
  messageTs: z.string(),
});

export const rankedDigestItemSchema = z.object({
  id: z.string(),
  relevance: z.number().min(0).max(100),
  category: z.enum([
    "needs_attention",
    "developer_signal",
    "product_change",
    "content_opportunity",
    "community_opportunity",
    "borderline",
  ]),
  urgency: z.enum(["today", "this_week", "fyi"]),
  headline: z.string().min(1).max(140),
  summary: z.string().min(1).max(800),
  whyRelevant: z.string().min(1).max(400),
  actionRequired: z.boolean(),
  suggestedAction: z.string().max(400).nullable(),
  sources: z.array(digestSourceSchema).min(1).max(5),
});

export const rankingBatchSchema = z.object({
  items: z.array(rankedDigestItemSchema),
});

export const structuredDigestSchema = z.object({
  title: z.string().min(1).max(120),
  overview: z.string().min(1).max(600),
  items: z.array(rankedDigestItemSchema),
  omittedThreadCount: z.number().int().nonnegative(),
});

export const profileUpdateSchema = z.object({
  currentPriorities: z.array(z.string().min(1).max(200)).max(30).optional(),
  watchTopics: z.array(z.string().min(1).max(200)).max(50).optional(),
  suppressSignals: z.array(z.string().min(1).max(200)).max(50).optional(),
  positiveExamples: z.array(z.string().min(1).max(300)).max(30).optional(),
  negativeExamples: z.array(z.string().min(1).max(300)).max(30).optional(),
  relevanceThreshold: z.number().int().min(0).max(100).optional(),
  borderlineThreshold: z.number().int().min(0).max(100).optional(),
});
