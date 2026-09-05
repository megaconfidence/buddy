import { describe, expect, it } from "vitest";
import { normalizeCategory } from "../src/ai/editorial";
import type { ChangeEvent, EditorialItem } from "../src/domain/types";

const item: EditorialItem = {
  id: "item",
  eventIds: ["event"],
  category: "must_know",
  title: "Synthetic test",
  summary: "Synthetic test",
  developerImpact: "None",
  importance: 1,
  contentPotential: 1,
  recommendedFormats: [],
  suggestedHook: null,
  demoIdea: null,
  effort: "low",
  freshness: "today",
};

function event(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    id: "event",
    sourceId: "news",
    sourceName: "Mistral News",
    sourceCategory: "product",
    sourceAuthority: 100,
    externalId: "event",
    changeType: "created",
    canonicalUrl: "https://mistral.ai/news/",
    title: "Synthetic test",
    content: "Synthetic",
    contentHash: "hash",
    artifactKey: null,
    publishedAt: 1,
    detectedAt: 1,
    metadata: {},
    ...overrides,
  };
}

describe("editorial category guard", () => {
  it("downgrades unsupported must-know classifications", () => {
    expect(normalizeCategory(item, [event()]).category).toBe("product");
    expect(
      normalizeCategory({ ...item, importance: 100 }, [event()]).category,
    ).toBe("product");
  });

  it("always treats security and retirement changes as must-know", () => {
    expect(
      normalizeCategory({ ...item, category: "other" }, [
        event({ sourceCategory: "security_lifecycle" }),
      ]).category,
    ).toBe("must_know");
    expect(
      normalizeCategory({ ...item, category: "other" }, [
        event({ changeType: "retired" }),
      ]).category,
    ).toBe("must_know");
    expect(
      normalizeCategory({ ...item, category: "other" }, [
        event({
          sourceCategory: "models_api",
          metadata: { removedOperations: ["POST /v1/legacy"] },
        }),
      ]).category,
    ).toBe("must_know");
  });
});
