import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceState } from "../src/domain/types";
import type { Env } from "../src/env";
import { fetchSource, SourceHttpError } from "../src/sources/http";

const state: SourceState = {
  sourceId: "test",
  etag: '"previous"',
  lastModified: "Sat, 05 Sep 2026 10:00:00 GMT",
  cursor: null,
  baselined: true,
  lastCheckedAt: 1,
  lastSuccessAt: 1,
  lastError: null,
  consecutiveFailures: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe("source HTTP client", () => {
  it("sends conditional headers", async () => {
    let headers = new Headers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        headers = new Headers(init?.headers);
        return new Response(null, { status: 304 });
      }),
    );

    const result = await fetchSource(
      {} as Env,
      "https://mistral.ai/news/rss",
      state,
    );
    expect(result.notModified).toBe(true);
    expect(headers.get("If-None-Match")).toBe('"previous"');
    expect(headers.get("If-Modified-Since")).toBe(
      "Sat, 05 Sep 2026 10:00:00 GMT",
    );
  });

  it("rejects non-allowlisted URLs before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchSource({} as Env, "https://attacker.example/prompt", state),
    ).rejects.toBeInstanceOf(SourceHttpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
