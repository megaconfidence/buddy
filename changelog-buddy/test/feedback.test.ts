import { describe, expect, it } from "vitest";
import { signFeedbackToken, verifyFeedbackToken } from "../src/feedback/tokens";

const secret = "a-secure-test-secret-that-is-long-enough";

describe("feedback tokens", () => {
  it("round-trips signed feedback", async () => {
    const token = await signFeedbackToken(secret, {
      digestId: "digest-1",
      itemId: "item-1",
      value: "pursue",
      expiresAt: 2_000,
    });
    await expect(verifyFeedbackToken(secret, token, 1_000)).resolves.toEqual({
      digestId: "digest-1",
      itemId: "item-1",
      value: "pursue",
      expiresAt: 2_000,
    });
  });

  it("rejects tampered and expired tokens", async () => {
    const token = await signFeedbackToken(secret, {
      digestId: "digest-1",
      itemId: "item-1",
      value: "handled",
      expiresAt: 2_000,
    });
    await expect(
      verifyFeedbackToken(secret, `${token}x`, 1_000),
    ).resolves.toBeNull();
    await expect(verifyFeedbackToken(secret, token, 3_000)).resolves.toBeNull();
  });
});
