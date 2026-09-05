import { describe, expect, it } from "vitest";
import { clusterChanges } from "../src/domain/deduplicate";
import { stableJson } from "../src/domain/hash";
import type { ChangeEvent } from "../src/domain/types";

function event(overrides: Partial<ChangeEvent>): ChangeEvent {
  return {
    id: "event-1",
    sourceId: "source-1",
    sourceName: "Source",
    sourceCategory: "sdk_tooling",
    sourceAuthority: 90,
    externalId: "1",
    changeType: "created",
    canonicalUrl: "https://example.com/change",
    title: "Mistral SDK 2.0",
    content: "Released",
    contentHash: "hash",
    artifactKey: "package:mistralai:2.0",
    publishedAt: 1,
    detectedAt: 2,
    metadata: {},
    ...overrides,
  };
}

describe("change deduplication", () => {
  it("groups registry and GitHub events for the same artifact", () => {
    const clusters = clusterChanges([
      event({ id: "github", sourceAuthority: 95 }),
      event({ id: "pypi", sourceId: "pypi", sourceAuthority: 90 }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.events.map((item) => item.id)).toEqual([
      "github",
      "pypi",
    ]);
  });

  it("creates stable JSON independently of object key order", () => {
    expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 }));
  });
});
