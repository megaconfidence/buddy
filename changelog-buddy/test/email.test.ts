import { describe, expect, it } from "vitest";
import type { ChangeEvent, EditorialDigest } from "../src/domain/types";
import { renderDigestEmail } from "../src/email/render";

const event: ChangeEvent = {
  id: "event-1",
  sourceId: "docs",
  sourceName: "Mistral Changelog",
  sourceCategory: "models_api",
  sourceAuthority: 100,
  externalId: "change-1",
  changeType: "created",
  canonicalUrl: "https://docs.mistral.ai/change",
  title: "New API",
  content: "A new API shipped.",
  contentHash: "hash",
  artifactKey: "api:new",
  publishedAt: 1,
  detectedAt: 2,
  metadata: {},
};

const digest: EditorialDigest = {
  overview: "A useful API capability shipped.",
  items: [
    {
      id: "cluster-api",
      eventIds: [event.id],
      category: "model_api",
      title: "Build with <New API>",
      summary: "The API adds a useful capability.",
      developerImpact: "Developers can build a new workflow.",
      importance: 80,
      contentPotential: 90,
      recommendedFormats: ["demo_app", "social_post"],
      suggestedHook: "Build it in ten minutes.",
      demoIdea: "Create a focused demo.",
      effort: "low",
      freshness: "today",
    },
  ],
};

describe("email rendering", () => {
  it("renders safe HTML, text fallback, sources, and feedback links", async () => {
    const rendered = await renderDigestEmail({
      digestId: "digest-2026-09-05",
      digest,
      events: [event],
      window: {
        localDate: "2026-09-05",
        timezone: "Europe/Paris",
        startMs: 0,
        endMs: 1,
      },
      sourceHealth: [
        {
          name: "Mistral Changelog",
          lastSuccessAt: 1,
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
      publicBaseUrl: "https://buddy.example.com",
      feedbackSecret: "a-secure-test-secret-that-is-long-enough",
    });

    expect(rendered.subject).toContain("1 content opportunity");
    expect(rendered.html).toContain("Build with &lt;New API&gt;");
    expect(rendered.html).toContain("https://docs.mistral.ai/change");
    expect(rendered.html).toContain("https://buddy.example.com/feedback");
    expect(rendered.html).toContain('src="cid:mistral-logo"');
    expect(rendered.html).toContain("#FA500F");
    expect(rendered.html).toContain("#151524");
    expect(rendered.html).toContain("border-radius:8px");
    expect(rendered.html).not.toContain("border-radius:14px");
    expect(rendered.html).not.toContain("font-size:10px");
    expect(rendered.html).not.toContain("font-size:11px");
    expect(rendered.html).not.toContain("1970-01-01T");
    expect(rendered.text).toContain("TOP CONTENT OPPORTUNITIES");
  });
});
