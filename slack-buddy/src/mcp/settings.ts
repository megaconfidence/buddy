import { z } from "zod";

const keyword = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[\p{L}\p{N} ._+-]+$/u, "Use words, not Slack search operators");
export const settingsSchema = z.object({
  priorities: z
    .array(
      z.object({ name: keyword, keywords: z.array(keyword).min(1).max(5) }),
    )
    .min(1)
    .max(5),
  radarKeywords: z.array(keyword).min(2).max(12),
  contentFormats: z
    .array(z.enum(["tutorial", "demo", "blog", "video", "workshop", "social"]))
    .min(1)
    .max(6),
  feedback: z
    .array(
      z.object({
        topic: keyword,
        dimension: z.enum(["relevance", "content"]),
        value: z.enum(["more", "less"]),
      }),
    )
    .max(30)
    .default([]),
  includePrivateChannels: z.boolean(),
  publicDiscovery: z.boolean(),
  dailyDelivery: z.boolean(),
  timezone: z
    .string()
    .max(80)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Invalid timezone"),
  digestHour: z.number().int().min(0).max(23),
});
export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: Settings = {
  priorities: [
    { name: "OCR", keywords: ["OCR", "document extraction"] },
    { name: "Vibe", keywords: ["Vibe", "coding agent"] },
  ],
  radarKeywords: [
    "release",
    "launch",
    "SDK",
    "documentation",
    "deprecation",
    "developer feedback",
  ],
  contentFormats: ["tutorial", "demo", "blog", "video"],
  feedback: [],
  includePrivateChannels: true,
  publicDiscovery: true,
  dailyDelivery: false,
  timezone: "Europe/Paris",
  digestHour: 8,
};

export type SearchPlan = {
  label: string;
  query: string;
  scope: "joined" | "public";
  mentions?: boolean;
};
export function planSearches(
  settings: Settings,
  owner: string,
  now: number,
): SearchPlan[] {
  const day = Math.floor(now / 86_400_000);
  const focus = settings.priorities.map((p) => ({
    label: p.name,
    query: p.keywords[0]!,
    scope: "joined" as const,
  }));
  const radar = settings.radarKeywords;
  const plan: SearchPlan[] = [
    {
      label: "Mentions",
      query: `<@${owner}>`,
      scope: "joined",
      mentions: true,
    },
    ...focus,
    {
      label: "DevRel radar",
      query: radar[day % radar.length]!,
      scope: "joined",
    },
    ...(settings.publicDiscovery
      ? [
          {
            label: "Wider public radar",
            query: radar[(day + 1) % radar.length]!,
            scope: "public" as const,
          },
        ]
      : []),
  ];
  // Keep at least two calls for thread context. Primary keywords and the broad
  // radar always come first; rotate aliases through the remaining search slots.
  const aliases = settings.priorities.flatMap((p) =>
    p.keywords.slice(1).map((query) => ({
      label: `${p.name} · ${query}`,
      query,
      scope: "joined" as const,
    })),
  );
  const slots = Math.min(aliases.length, Math.max(0, 8 - plan.length));
  for (let i = 0; i < slots; i++)
    plan.push(aliases[(day + i) % aliases.length]!);
  return plan;
}
