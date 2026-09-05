import { sha256, stableJson } from "../domain/hash";
import type {
  CollectedItem,
  CollectionResult,
  SourceDefinition,
  SourceState,
} from "../domain/types";
import type { Env } from "../env";
import { fetchSource } from "./http";
import { collectRss } from "./rss";
import { cleanText, parseDate } from "./text";

type GitHubRelease = {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url: string;
  published_at?: string | null;
  created_at?: string;
  updated_at?: string;
  draft?: boolean;
  prerelease?: boolean;
};

type GitHubCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { date?: string };
    committer?: { date?: string };
  };
  files?: Array<{
    filename: string;
    status?: string;
    patch?: string;
  }>;
};

type GitHubAdvisory = {
  ghsa_id: string;
  cve_id?: string | null;
  html_url: string;
  summary: string;
  description?: string;
  severity?: string;
  published_at?: string;
  updated_at?: string;
  withdrawn_at?: string | null;
  vulnerabilities?: Array<{
    package?: { ecosystem?: string; name?: string };
    vulnerable_version_range?: string;
    first_patched_version?: { identifier?: string } | null;
  }>;
};

export async function collectGitHubReleases(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  if (!env.GITHUB_TOKEN) {
    return collectGitHubReleaseFeed(env, source, state);
  }
  const url = new URL(source.url);
  url.searchParams.set("per_page", "50");
  const response = await fetchSource(env, url.toString(), state, {
    accept: "application/vnd.github+json",
  });
  if (response.notModified) {
    return unchanged(response, state);
  }

  const releases = JSON.parse(response.body) as GitHubRelease[];
  const items = await Promise.all(
    releases
      .filter((release) => !release.draft)
      .map(async (release): Promise<CollectedItem> => {
        const content = cleanText(release.body ?? "", 40_000);
        const metadata = {
          tag: release.tag_name,
          prerelease: release.prerelease ?? false,
          repository: source.options?.repository ?? null,
        };
        return {
          sourceId: source.id,
          externalId: release.tag_name,
          canonicalUrl: release.html_url,
          title: cleanText(release.name || release.tag_name, 300),
          publishedAt: parseDate(release.published_at ?? release.created_at),
          updatedAt: parseDate(release.updated_at),
          content,
          contentHash: await sha256(
            stableJson({ title: release.name, content, metadata }),
          ),
          artifactKey: `package:${
            source.options?.packageName ?? source.options?.repository
          }:${normalizeVersion(release.tag_name)}`,
          metadata,
        };
      }),
  );

  return changedResult(response, items, newestTimestamp(items, state.cursor));
}

export async function collectGitHubCommits(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  if (!env.GITHUB_TOKEN) {
    return collectGitHubCommitFeed(env, source, state);
  }
  const url = new URL(source.url);
  url.searchParams.set("per_page", state.baselined ? "30" : "10");
  if (source.options?.path) {
    url.searchParams.set("path", source.options.path);
  }
  if (state.cursor) url.searchParams.set("since", state.cursor);

  const response = await fetchSource(env, url.toString(), state, {
    accept: "application/vnd.github+json",
  });
  if (response.notModified) return unchanged(response, state);

  const summaries = JSON.parse(response.body) as GitHubCommit[];
  const commits = state.baselined
    ? await Promise.all(
        summaries
          .slice(0, 20)
          .map((commit) => fetchCommitDetail(env, source, commit)),
      )
    : summaries;
  const items = await Promise.all(
    commits.map(async (commit): Promise<CollectedItem> => {
      const [title = "Repository update", ...body] =
        commit.commit.message.split("\n");
      const files = (commit.files ?? [])
        .filter(
          (file) =>
            !source.options?.path ||
            file.filename.startsWith(source.options.path),
        )
        .map((file) => ({
          path: file.filename,
          status: file.status,
          patch: cleanText(file.patch ?? "", 8_000),
        }));
      const content = cleanText(
        `${body.join("\n")}\n${files
          .map(
            (file) => `${file.status ?? "changed"} ${file.path}\n${file.patch}`,
          )
          .join("\n")}`,
        40_000,
      );
      const publishedAt = parseDate(
        commit.commit.author?.date ?? commit.commit.committer?.date,
      );
      const metadata = {
        sha: commit.sha,
        files: files.map((file) => ({
          path: file.path,
          status: file.status ?? null,
        })),
        repository: source.options?.repository ?? null,
      };
      return {
        sourceId: source.id,
        externalId: commit.sha,
        canonicalUrl: commit.html_url,
        title: cleanText(title, 300),
        publishedAt,
        updatedAt: publishedAt,
        content,
        contentHash: await sha256(stableJson({ title, content, metadata })),
        artifactKey: `commit:${source.options?.repository}:${commit.sha}`,
        metadata,
      };
    }),
  );

  const newest = items
    .map((item) => item.updatedAt ?? item.publishedAt ?? 0)
    .sort((left, right) => right - left)[0];
  return changedResult(
    response,
    items,
    newest ? new Date(newest).toISOString() : state.cursor,
  );
}

export async function collectGitHubAdvisories(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  const url = new URL(source.url);
  url.searchParams.set("per_page", "50");
  const response = await fetchSource(env, url.toString(), state, {
    accept: "application/vnd.github+json",
  });
  if (response.notModified) return unchanged(response, state);

  const advisories = JSON.parse(response.body) as GitHubAdvisory[];
  const items = await Promise.all(
    advisories.map(async (advisory): Promise<CollectedItem> => {
      const vulnerabilities = (advisory.vulnerabilities ?? []).map(
        (vulnerability) => ({
          ecosystem: vulnerability.package?.ecosystem ?? null,
          package: vulnerability.package?.name ?? null,
          vulnerableRange: vulnerability.vulnerable_version_range ?? null,
          patchedVersion:
            vulnerability.first_patched_version?.identifier ?? null,
        }),
      );
      const metadata = {
        ghsaId: advisory.ghsa_id,
        cveId: advisory.cve_id ?? null,
        severity: advisory.severity ?? null,
        withdrawnAt: advisory.withdrawn_at ?? null,
        vulnerabilities,
        repository: source.options?.repository ?? null,
      };
      const content = cleanText(
        `${advisory.summary}\n${advisory.description ?? ""}\n${vulnerabilities
          .map(
            (vulnerability) =>
              `${vulnerability.ecosystem ?? ""} ${
                vulnerability.package ?? ""
              } ${vulnerability.vulnerableRange ?? ""} ${
                vulnerability.patchedVersion
                  ? `patched in ${vulnerability.patchedVersion}`
                  : ""
              }`,
          )
          .join("\n")}`,
        40_000,
      );
      return {
        sourceId: source.id,
        externalId: advisory.ghsa_id,
        canonicalUrl: advisory.html_url,
        title: advisory.summary,
        publishedAt: parseDate(advisory.published_at),
        updatedAt: parseDate(advisory.updated_at),
        content,
        contentHash: await sha256(stableJson({ content, metadata })),
        artifactKey: `advisory:${advisory.ghsa_id}`,
        metadata,
      };
    }),
  );
  return changedResult(response, items, newestTimestamp(items, state.cursor));
}

async function fetchCommitDetail(
  env: Env,
  source: SourceDefinition,
  commit: GitHubCommit,
): Promise<GitHubCommit> {
  const repository = source.options?.repository;
  if (!repository) return commit;
  const response = await fetchSource(
    env,
    `https://api.github.com/repos/${repository}/commits/${commit.sha}`,
    emptyState(source.id),
    {
      accept: "application/vnd.github+json",
      maxBytes: 1_500_000,
    },
  );
  return response.notModified
    ? commit
    : (JSON.parse(response.body) as GitHubCommit);
}

function unchanged(
  response: { etag: string | null; lastModified: string | null },
  state: SourceState,
): CollectionResult {
  return {
    notModified: true,
    items: [],
    etag: response.etag ?? state.etag,
    lastModified: response.lastModified ?? state.lastModified,
    cursor: state.cursor,
  };
}

function changedResult(
  response: { etag: string | null; lastModified: string | null },
  items: CollectedItem[],
  cursor: string | null,
): CollectionResult {
  return {
    notModified: false,
    items,
    etag: response.etag,
    lastModified: response.lastModified,
    cursor,
  };
}

function newestTimestamp(items: CollectedItem[], fallback: string | null) {
  const newest = items
    .map((item) => item.updatedAt ?? item.publishedAt ?? 0)
    .sort((left, right) => right - left)[0];
  return newest ? new Date(newest).toISOString() : fallback;
}

function emptyState(sourceId: string): SourceState {
  return {
    sourceId,
    etag: null,
    lastModified: null,
    cursor: null,
    baselined: true,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
  };
}

function normalizeVersion(value: string): string {
  return value.replace(/^[a-z-]*v(?=\d)/iu, "");
}

async function collectGitHubReleaseFeed(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  const repository = source.options?.repository;
  if (!repository) throw new Error(`${source.id} has no GitHub repository`);
  const result = await collectRss(
    env,
    {
      ...source,
      kind: "rss",
      url: `https://github.com/${repository}/releases.atom`,
    },
    state,
  );
  return {
    ...result,
    items: result.items.map((item) => {
      const tag = releaseTag(item.canonicalUrl, item.title);
      return {
        ...item,
        externalId: tag,
        artifactKey: `package:${
          source.options?.packageName ?? repository
        }:${normalizeVersion(tag)}`,
        metadata: {
          ...item.metadata,
          repository,
          tag,
          feedFallback: true,
        },
      };
    }),
  };
}

async function collectGitHubCommitFeed(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  const repository = source.options?.repository;
  if (!repository) throw new Error(`${source.id} has no GitHub repository`);
  const path = source.options?.path ? `/${source.options.path}` : "";
  const result = await collectRss(
    env,
    {
      ...source,
      kind: "rss",
      url: `https://github.com/${repository}/commits/main${path}.atom`,
    },
    state,
  );
  return {
    ...result,
    items: result.items.map((item) => {
      const sha = item.canonicalUrl.match(/\/commit\/([a-f0-9]+)/iu)?.[1];
      return {
        ...item,
        externalId: sha ?? item.externalId,
        artifactKey: `commit:${repository}:${sha ?? item.externalId}`,
        metadata: {
          ...item.metadata,
          repository,
          sha: sha ?? null,
          feedFallback: true,
        },
      };
    }),
  };
}

function releaseTag(url: string, title: string): string {
  try {
    const candidate = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    if (candidate) return decodeURIComponent(candidate);
  } catch {
    // Fall through to the title.
  }
  return title.match(/\bv?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?/iu)?.[0] ?? title;
}
