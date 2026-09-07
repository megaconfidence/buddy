import { describe, expect, it } from "vitest";
import { shouldSendDigest } from "../src/domain/delivery";

const healthySource = {
  lastSuccessAt: Date.now(),
  consecutiveFailures: 0,
};

describe("digest delivery policy", () => {
  it("skips email when there are no updates and every source is healthy", () => {
    expect(shouldSendDigest(0, [healthySource])).toBe(false);
  });

  it("sends email when at least one update exists", () => {
    expect(shouldSendDigest(1, [healthySource])).toBe(true);
  });

  it("still reports source coverage problems without updates", () => {
    expect(shouldSendDigest(0, [])).toBe(true);
    expect(
      shouldSendDigest(0, [{ lastSuccessAt: null, consecutiveFailures: 0 }]),
    ).toBe(true);
    expect(
      shouldSendDigest(0, [
        { lastSuccessAt: Date.now(), consecutiveFailures: 1 },
      ]),
    ).toBe(true);
  });
});
