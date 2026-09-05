import type { SourceDefinition } from "../domain/types";

export const SOURCES: readonly SourceDefinition[] = [
  {
    id: "mistral-news",
    name: "Mistral News",
    kind: "rss",
    category: "product",
    url: "https://mistral.ai/news/rss",
    canonicalUrl: "https://mistral.ai/news/",
    pollIntervalMinutes: 30,
    authority: 100,
  },
  {
    id: "mistral-status",
    name: "Mistral Status",
    kind: "rss",
    category: "reliability",
    url: "https://status.mistral.ai/feed.rss",
    canonicalUrl: "https://status.mistral.ai/activity/page/1",
    pollIntervalMinutes: 30,
    authority: 100,
  },
  {
    id: "docs-changelog",
    name: "Mistral Docs Changelog",
    kind: "github_commits",
    category: "models_api",
    url: "https://api.github.com/repos/mistralai/platform-docs-public/commits",
    canonicalUrl: "https://docs.mistral.ai/resources/changelogs",
    pollIntervalMinutes: 60,
    authority: 100,
    options: {
      repository: "mistralai/platform-docs-public",
      path: "changelog/en",
    },
  },
  {
    id: "docs-release-notes",
    name: "Mistral Product Release Notes",
    kind: "github_commits",
    category: "product",
    url: "https://api.github.com/repos/mistralai/platform-docs-public/commits",
    canonicalUrl: "https://docs.mistral.ai/resources/release-notes",
    pollIntervalMinutes: 60,
    authority: 100,
    options: {
      repository: "mistralai/platform-docs-public",
      path: "src/data/releases/en",
    },
  },
  {
    id: "security-advisories",
    name: "Mistral Security Advisories",
    kind: "github_commits",
    category: "security_lifecycle",
    url: "https://api.github.com/repos/mistralai/platform-docs-public/commits",
    canonicalUrl: "https://docs.mistral.ai/resources/security-advisories",
    pollIntervalMinutes: 60,
    authority: 100,
    options: {
      repository: "mistralai/platform-docs-public",
      path: "src/content/en/docs/resources/security-advisories",
    },
  },
  {
    id: "model-lifecycle",
    name: "Mistral Model Lifecycle",
    kind: "github_commits",
    category: "security_lifecycle",
    url: "https://api.github.com/repos/mistralai/platform-docs-public/commits",
    canonicalUrl: "https://docs.mistral.ai/inference/model-lifecycle",
    pollIntervalMinutes: 360,
    authority: 100,
    options: {
      repository: "mistralai/platform-docs-public",
      path: "src/content/en/docs/inference/model-lifecycle/page.mdx",
    },
  },
  {
    id: "model-definitions",
    name: "Mistral Model Definitions",
    kind: "github_commits",
    category: "models_api",
    url: "https://api.github.com/repos/mistralai/platform-docs-public/commits",
    canonicalUrl: "https://docs.mistral.ai/models/overview",
    pollIntervalMinutes: 60,
    authority: 100,
    options: {
      repository: "mistralai/platform-docs-public",
      path: "src/schema/models/models",
    },
  },
  {
    id: "search-toolkit-changelog",
    name: "Search Toolkit Changelog",
    kind: "html_snapshot",
    category: "sdk_tooling",
    url: "https://docs.mistral.ai/studio/search/search-toolkit/changelog",
    canonicalUrl:
      "https://docs.mistral.ai/studio/search/search-toolkit/changelog",
    pollIntervalMinutes: 240,
    authority: 100,
  },
  {
    id: "public-openapi",
    name: "Mistral Public OpenAPI",
    kind: "openapi",
    category: "models_api",
    url: "https://docs.mistral.ai/openapi.yaml",
    canonicalUrl: "https://docs.mistral.ai/api/",
    pollIntervalMinutes: 60,
    authority: 100,
  },
  ...githubReleaseSources(),
  ...githubAdvisorySources(),
  {
    id: "mistral-cookbook",
    name: "Mistral Cookbook",
    kind: "github_commits",
    category: "cookbook",
    url: "https://api.github.com/repos/mistralai/cookbook/commits",
    canonicalUrl: "https://github.com/mistralai/cookbook",
    pollIntervalMinutes: 60,
    authority: 95,
    options: {
      repository: "mistralai/cookbook",
    },
  },
  ...pypiSources(),
  {
    id: "npm-typescript-sdk",
    name: "Mistral TypeScript SDK on npm",
    kind: "npm",
    category: "sdk_tooling",
    url: "https://registry.npmjs.org/@mistralai%2Fmistralai",
    canonicalUrl: "https://www.npmjs.com/package/@mistralai/mistralai",
    pollIntervalMinutes: 30,
    authority: 90,
    options: { packageName: "@mistralai/mistralai" },
  },
  {
    id: "huggingface-models",
    name: "Mistral Models on Hugging Face",
    kind: "huggingface_models",
    category: "models_api",
    url: "https://huggingface.co/api/models?author=mistralai&sort=lastModified&direction=-1&limit=100&full=true",
    canonicalUrl: "https://huggingface.co/mistralai/models",
    pollIntervalMinutes: 60,
    authority: 95,
  },
];

export function sourceById(sourceId: string): SourceDefinition {
  const source = SOURCES.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  return source;
}

function githubReleaseSources(): SourceDefinition[] {
  const releases: Array<[string, string, string, string]> = [
    [
      "python-sdk",
      "Mistral Python SDK",
      "mistralai/client-python",
      "mistralai",
    ],
    [
      "typescript-sdk",
      "Mistral TypeScript SDK",
      "mistralai/client-ts",
      "@mistralai/mistralai",
    ],
    ["mistral-vibe", "Mistral Vibe", "mistralai/mistral-vibe", "mistral-vibe"],
    [
      "mistral-common",
      "mistral-common",
      "mistralai/mistral-common",
      "mistral-common",
    ],
  ];
  return releases.map(([id, name, repository, packageName]) => ({
    id: `github-${id}`,
    name,
    kind: "github_releases" as const,
    category: "sdk_tooling" as const,
    url: `https://api.github.com/repos/${repository}/releases`,
    canonicalUrl: `https://github.com/${repository}/releases`,
    pollIntervalMinutes: 30,
    authority: 95,
    options: { repository, packageName },
  }));
}

function pypiSources(): SourceDefinition[] {
  const packages: Array<[string, string, string]> = [
    ["mistralai", "Mistral Python SDK on PyPI", "mistralai"],
    ["mistral-vibe", "Mistral Vibe on PyPI", "mistral-vibe"],
    ["mistral-common", "mistral-common on PyPI", "mistral-common"],
  ];
  return packages.map(([id, name, packageName]) => ({
    id: `pypi-${id}`,
    name,
    kind: "pypi" as const,
    category: "sdk_tooling" as const,
    url: `https://pypi.org/pypi/${packageName}/json`,
    canonicalUrl: `https://pypi.org/project/${packageName}/`,
    pollIntervalMinutes: 30,
    authority: 90,
    options: { packageName },
  }));
}

function githubAdvisorySources(): SourceDefinition[] {
  const repositories: Array<[string, string]> = [
    ["client-python", "Python SDK Security Advisories"],
    ["client-ts", "TypeScript SDK Security Advisories"],
    ["mistral-vibe", "Mistral Vibe Security Advisories"],
    ["mistral-common", "mistral-common Security Advisories"],
  ];
  return repositories.map(([repository, name]) => ({
    id: `github-advisories-${repository}`,
    name,
    kind: "github_advisories" as const,
    category: "security_lifecycle" as const,
    url: `https://api.github.com/repos/mistralai/${repository}/security-advisories`,
    canonicalUrl: `https://github.com/mistralai/${repository}/security/advisories`,
    pollIntervalMinutes: 60,
    authority: 95,
    options: { repository: `mistralai/${repository}` },
  }));
}
