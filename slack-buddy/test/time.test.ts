import { describe, expect, it } from "vitest";
import {
  digestWindowForDate,
  localDateAt,
  targetDigestDate,
} from "../src/domain/time";

describe("digest time windows", () => {
  it("uses the previous local day after delivery time", () => {
    const now = Date.parse("2026-09-05T10:30:00Z");
    expect(targetDigestDate(now, "Europe/Paris", 8)).toBe("2026-09-04");
  });

  it("does not create today's scheduled digest before delivery time", () => {
    const now = Date.parse("2026-09-05T05:30:00Z");
    expect(targetDigestDate(now, "Europe/Paris", 8)).toBeNull();
  });

  it("handles the short DST day", () => {
    const window = digestWindowForDate("2026-03-29", "Europe/Paris");
    expect(window.endMs - window.startMs).toBe(23 * 60 * 60 * 1_000);
    expect(localDateAt(window.startMs, "Europe/Paris")).toBe("2026-03-29");
  });

  it("handles the long DST day", () => {
    const window = digestWindowForDate("2026-10-25", "Europe/Paris");
    expect(window.endMs - window.startMs).toBe(25 * 60 * 60 * 1_000);
  });
});
