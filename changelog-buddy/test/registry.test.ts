import { describe, expect, it } from "vitest";
import { SOURCES } from "../src/sources/registry";

describe("source registry", () => {
  it("uses unique identifiers and HTTPS URLs", () => {
    expect(new Set(SOURCES.map((source) => source.id)).size).toBe(
      SOURCES.length,
    );
    for (const source of SOURCES) {
      expect(new URL(source.url).protocol).toBe("https:");
      expect(source.pollIntervalMinutes).toBeGreaterThan(0);
    }
  });

  it("covers the agreed high-signal source families", () => {
    const kinds = new Set(SOURCES.map((source) => source.kind));
    expect(kinds).toEqual(
      new Set([
        "rss",
        "github_releases",
        "github_commits",
        "github_advisories",
        "pypi",
        "npm",
        "huggingface_models",
        "html_snapshot",
        "openapi",
      ]),
    );
  });
});
