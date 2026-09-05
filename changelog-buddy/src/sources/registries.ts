import { sha256, stableJson } from "../domain/hash";
import type {
  CollectedItem,
  CollectionResult,
  SourceDefinition,
  SourceState,
} from "../domain/types";
import type { Env } from "../env";
import { fetchSource } from "./http";
import { cleanText, parseDate } from "./text";

type PyPiResponse = {
  info?: {
    name?: string;
    summary?: string;
    project_urls?: Record<string, string>;
  };
  releases?: Record<
    string,
    Array<{
      upload_time_iso_8601?: string;
      yanked?: boolean;
      yanked_reason?: string | null;
      requires_python?: string | null;
      filename?: string;
    }>
  >;
};

type NpmResponse = {
  name?: string;
  time?: Record<string, string>;
  versions?: Record<
    string,
    {
      name?: string;
      version?: string;
      description?: string;
      deprecated?: string;
      engines?: Record<string, string>;
      dist?: { integrity?: string; tarball?: string };
    }
  >;
};

export async function collectPyPi(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  const response = await fetchSource(env, source.url, state, {
    accept: "application/json",
    maxBytes: 5_000_000,
  });
  if (response.notModified) return unchanged(response, state);

  const body = JSON.parse(response.body) as PyPiResponse;
  const packageName =
    source.options?.packageName ?? body.info?.name ?? source.id;
  const items = await Promise.all(
    Object.entries(body.releases ?? {}).map(
      async ([version, files]): Promise<CollectedItem> => {
        const uploadedAt = files
          .map((file) => parseDate(file.upload_time_iso_8601))
          .filter((value): value is number => value !== null)
          .sort((left, right) => left - right)[0];
        const yanked = files.length > 0 && files.every((file) => file.yanked);
        const metadata = {
          packageName,
          version,
          yanked,
          yankedReasons: [
            ...new Set(
              files
                .map((file) => file.yanked_reason)
                .filter((value): value is string => Boolean(value)),
            ),
          ],
          requiresPython: [
            ...new Set(
              files
                .map((file) => file.requires_python)
                .filter((value): value is string => Boolean(value)),
            ),
          ],
          files: files
            .map((file) => file.filename)
            .filter((value): value is string => Boolean(value)),
        };
        const content = cleanText(
          `${body.info?.summary ?? ""} ${
            yanked
              ? `This release was yanked. ${metadata.yankedReasons.join(" ")}`
              : ""
          }`,
        );
        return {
          sourceId: source.id,
          externalId: version,
          canonicalUrl: `https://pypi.org/project/${packageName}/${version}/`,
          title: `${packageName} ${version}${yanked ? " (yanked)" : ""}`,
          publishedAt: uploadedAt ?? null,
          updatedAt: uploadedAt ?? null,
          content,
          contentHash: await sha256(stableJson(metadata)),
          artifactKey: `package:${packageName}:${version}`,
          metadata,
        };
      },
    ),
  );

  return changed(response, items, newest(items, state.cursor));
}

export async function collectNpm(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  const response = await fetchSource(env, source.url, state, {
    accept: "application/json",
    maxBytes: 8_000_000,
  });
  if (response.notModified) return unchanged(response, state);

  const body = JSON.parse(response.body) as NpmResponse;
  const packageName = source.options?.packageName ?? body.name ?? source.id;
  const items = await Promise.all(
    Object.entries(body.versions ?? {}).map(
      async ([version, value]): Promise<CollectedItem> => {
        const publishedAt = parseDate(body.time?.[version]);
        const metadata = {
          packageName,
          version,
          deprecated: value.deprecated ?? null,
          engines: value.engines ?? {},
          integrity: value.dist?.integrity ?? null,
        };
        const content = cleanText(
          `${value.description ?? ""} ${
            value.deprecated ? `Deprecated: ${value.deprecated}` : ""
          }`,
        );
        return {
          sourceId: source.id,
          externalId: version,
          canonicalUrl: `https://www.npmjs.com/package/${packageName}/v/${version}`,
          title: `${packageName} ${version}${
            value.deprecated ? " (deprecated)" : ""
          }`,
          publishedAt,
          updatedAt: publishedAt,
          content,
          contentHash: await sha256(stableJson(metadata)),
          artifactKey: `package:${packageName}:${version}`,
          metadata,
        };
      },
    ),
  );

  return changed(response, items, newest(items, state.cursor));
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

function changed(
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

function newest(
  items: CollectedItem[],
  fallback: string | null,
): string | null {
  const timestamp = items
    .map((item) => item.updatedAt ?? item.publishedAt ?? 0)
    .sort((left, right) => right - left)[0];
  return timestamp ? new Date(timestamp).toISOString() : fallback;
}
