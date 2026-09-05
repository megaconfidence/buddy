import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceDefinition, SourceState } from "../src/domain/types";
import type { Env } from "../src/env";
import { collectRss } from "../src/sources/rss";

const source: SourceDefinition = {
  id: "mistral-news",
  name: "Mistral News",
  kind: "rss",
  category: "product",
  url: "https://mistral.ai/news/rss",
  canonicalUrl: "https://mistral.ai/news/",
  pollIntervalMinutes: 120,
  authority: 100,
};

const state: SourceState = {
  sourceId: source.id,
  etag: null,
  lastModified: null,
  cursor: null,
  baselined: false,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe("RSS collection", () => {
  it("normalizes and hashes RSS entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `<?xml version="1.0"?><rss version="2.0"><channel><item>
            <title>New API feature</title>
            <link>https://mistral.ai/news/new-api/</link>
            <guid>https://mistral.ai/news/new-api/</guid>
            <pubDate>Sat, 05 Sep 2026 12:00:00 GMT</pubDate>
            <description><![CDATA[<p>A useful developer feature.</p>]]></description>
          </item></channel></rss>`,
            {
              headers: {
                "content-type": "application/rss+xml",
                etag: '"news-1"',
              },
            },
          ),
      ),
    );

    const result = await collectRss({} as Env, source, state);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceId: "mistral-news",
      title: "New API feature",
      content: "A useful developer feature.",
    });
    expect(result.items[0]?.contentHash).toHaveLength(64);
  });
});
