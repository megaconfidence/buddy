import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceDefinition, SourceState } from "../src/domain/types";
import type { Env } from "../src/env";
import {
  collectGitHubAdvisories,
  collectGitHubReleases,
} from "../src/sources/github";

const source: SourceDefinition = {
  id: "github-python-sdk",
  name: "Mistral Python SDK",
  kind: "github_releases",
  category: "sdk_tooling",
  url: "https://api.github.com/repos/mistralai/client-python/releases",
  canonicalUrl: "https://github.com/mistralai/client-python/releases",
  pollIntervalMinutes: 180,
  authority: 95,
  options: {
    repository: "mistralai/client-python",
    packageName: "mistralai",
  },
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

describe("GitHub release collection", () => {
  it("uses the public Atom fallback without a token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `<feed xmlns="http://www.w3.org/2005/Atom">
            <entry>
              <id>tag:github.com,2008:Repository/1/v2.9.4</id>
              <title>python - v2.9.4</title>
              <updated>2026-09-05T12:00:00Z</updated>
              <link href="https://github.com/mistralai/client-python/releases/tag/v2.9.4"/>
              <content type="html">&lt;p&gt;New SDK release.&lt;/p&gt;</content>
            </entry>
          </feed>`,
            { headers: { "content-type": "application/atom+xml" } },
          ),
      ),
    );

    const result = await collectGitHubReleases({} as Env, source, state);
    expect(result.items[0]).toMatchObject({
      externalId: "v2.9.4",
      artifactKey: "package:mistralai:2.9.4",
    });
  });

  it("normalizes public repository security advisories", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          {
            ghsa_id: "GHSA-1234-5678-9012",
            cve_id: "CVE-2026-1234",
            html_url:
              "https://github.com/mistralai/client-python/security/advisories/GHSA-1234-5678-9012",
            summary: "A test SDK advisory",
            description: "Upgrade to the patched release.",
            severity: "high",
            published_at: "2026-09-05T12:00:00Z",
            updated_at: "2026-09-05T12:30:00Z",
            vulnerabilities: [
              {
                package: { ecosystem: "pip", name: "mistralai" },
                vulnerable_version_range: "<2.9.5",
                first_patched_version: { identifier: "2.9.5" },
              },
            ],
          },
        ]),
      ),
    );
    const advisorySource: SourceDefinition = {
      ...source,
      id: "github-advisories-client-python",
      kind: "github_advisories",
      category: "security_lifecycle",
      url: "https://api.github.com/repos/mistralai/client-python/security-advisories",
    };
    const result = await collectGitHubAdvisories(
      { GITHUB_TOKEN: "test" } as Env,
      advisorySource,
      state,
    );
    expect(result.items[0]).toMatchObject({
      externalId: "GHSA-1234-5678-9012",
      artifactKey: "advisory:GHSA-1234-5678-9012",
      title: "A test SDK advisory",
    });
  });
});
