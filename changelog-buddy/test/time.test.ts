import { describe, expect, it } from "vitest";
import {
  digestWindowForDeliveryDate,
  targetDigestDate,
} from "../src/domain/time";

describe("digest scheduling", () => {
  it("selects today's delivery date after 08:00", () => {
    expect(
      targetDigestDate(Date.parse("2026-09-05T06:15:00Z"), "Europe/Paris", 8),
    ).toBe("2026-09-05");
  });

  it("waits before the delivery hour", () => {
    expect(
      targetDigestDate(Date.parse("2026-09-05T05:59:00Z"), "Europe/Paris", 8),
    ).toBeNull();
  });

  it("handles daylight-saving boundaries", () => {
    const spring = digestWindowForDeliveryDate("2026-03-29", "Europe/Paris", 8);
    const autumn = digestWindowForDeliveryDate("2026-10-25", "Europe/Paris", 8);
    expect(spring.endMs - spring.startMs).toBe(23 * 3_600_000);
    expect(autumn.endMs - autumn.startMs).toBe(25 * 3_600_000);
  });
});
