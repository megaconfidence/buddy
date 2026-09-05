import { describe, expect, it } from "vitest";
import type { StructuredDigest } from "../src/domain/types";
import { renderDigest, renderDigestBlocks } from "../src/slack/render";

const digest: StructuredDigest = {
  title: "Buddy briefing",
  overview: "One item needs your attention.",
  omittedThreadCount: 2,
  items: [
    {
      id: "item-1",
      relevance: 92,
      category: "needs_attention",
      urgency: "today",
      headline: "SDK authentication docs are blocking developers",
      summary: "Several developers could not complete authentication.",
      whyRelevant: "This is a recurring developer-experience issue.",
      actionRequired: true,
      suggestedAction: "Add a working authentication example.",
      sources: [
        {
          channelId: "C123",
          channelName: "developers",
          threadTs: "100.000001",
          messageTs: "101.000001",
        },
      ],
    },
  ],
};

const window = {
  localDate: "2026-09-04",
  timezone: "Europe/Paris",
  startMs: 0,
  endMs: 1,
};

describe("Slack digest rendering", () => {
  it("renders a source-linked text fallback", () => {
    const rendered = renderDigest(digest, window, "T123");
    expect(rendered).toContain("Buddy briefing · 2026-09-04");
    expect(rendered).toContain("slack://channel?");
    expect(rendered).toContain("Suggested action");
  });

  it("renders per-item learning controls within Slack's block limit", () => {
    const blocks = renderDigestBlocks(
      digest,
      window,
      "T123",
      "buddy-2026-09-04-T123-U123",
    ) as Array<Record<string, unknown>>;
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.some((block) => block.type === "actions")).toBe(true);
  });
});
