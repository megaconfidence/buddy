import type {
  CollectionResult,
  SourceDefinition,
  SourceState,
} from "../domain/types";
import type { Env } from "../env";
import {
  collectGitHubAdvisories,
  collectGitHubCommits,
  collectGitHubReleases,
} from "./github";
import { collectHuggingFaceModels } from "./huggingface";
import { collectNpm, collectPyPi } from "./registries";
import { collectRss } from "./rss";
import { collectHtmlSnapshot, collectOpenApi } from "./snapshots";

export async function collectSource(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  switch (source.kind) {
    case "rss":
      return collectRss(env, source, state);
    case "github_releases":
      return collectGitHubReleases(env, source, state);
    case "github_commits":
      return collectGitHubCommits(env, source, state);
    case "github_advisories":
      return collectGitHubAdvisories(env, source, state);
    case "pypi":
      return collectPyPi(env, source, state);
    case "npm":
      return collectNpm(env, source, state);
    case "huggingface_models":
      return collectHuggingFaceModels(env, source, state);
    case "html_snapshot":
      return collectHtmlSnapshot(env, source, state);
    case "openapi":
      return collectOpenApi(env, source, state);
  }
}
