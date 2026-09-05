import { z } from "zod";

export const editorialItemSchema = z.object({
  id: z.string().min(1).max(200),
  eventIds: z.array(z.string().min(1)).min(1).max(20),
  category: z.enum([
    "must_know",
    "model_api",
    "sdk_tooling",
    "product",
    "reliability",
    "other",
  ]),
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(800),
  developerImpact: z.string().min(1).max(500),
  importance: z.number().min(0).max(100),
  contentPotential: z.number().min(0).max(100),
  recommendedFormats: z
    .array(z.enum(["social_post", "demo_app", "cookbook", "video"]))
    .max(4),
  suggestedHook: z.string().max(500).nullable(),
  demoIdea: z.string().max(800).nullable(),
  effort: z.enum(["low", "medium", "high"]),
  freshness: z.enum(["today", "this_week", "evergreen"]),
});

export const editorialDigestSchema = z.object({
  overview: z.string().min(1).max(800),
  items: z.array(editorialItemSchema).max(30),
});
