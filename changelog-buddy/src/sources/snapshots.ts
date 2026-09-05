import { parse as parseYaml } from "yaml";
import { sha256, stableJson } from "../domain/hash";
import type {
  CollectedItem,
  CollectionResult,
  JsonValue,
  SourceDefinition,
  SourceState,
} from "../domain/types";
import type { Env } from "../env";
import { fetchSource } from "./http";
import { cleanText } from "./text";

export async function collectHtmlSnapshot(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  const response = await fetchSource(env, source.url, state, {
    accept: "text/html, text/plain;q=0.8",
    maxBytes: 5_000_000,
  });
  if (response.notModified) return unchanged(response, state);

  const snapshotKey = `sources/${source.id}/latest`;
  const previous = await env.SNAPSHOTS.get(snapshotKey);
  const previousBody = previous ? await previous.text() : null;
  const nextBlocks = extractTextBlocks(extractMain(response.body));
  const previousBlocks = previousBody
    ? new Set(extractTextBlocks(extractMain(previousBody)))
    : new Set<string>();
  const changedBlocks = previousBody
    ? nextBlocks.filter((block) => !previousBlocks.has(block))
    : nextBlocks;
  const content = cleanText(
    (changedBlocks.length > 0 ? changedBlocks : nextBlocks.slice(0, 20)).join(
      "\n",
    ),
    50_000,
  );
  const normalizedPage = cleanText(extractMain(response.body), 200_000);
  const pageTitle =
    cleanText(
      response.body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] ??
        response.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ??
        source.name,
      300,
    ) || source.name;
  const title = changedBlocks.find((block) => block.length <= 200) ?? pageTitle;
  const contentHash = await sha256(normalizedPage);
  const item: CollectedItem = {
    sourceId: source.id,
    externalId: source.id,
    canonicalUrl: source.canonicalUrl,
    title,
    publishedAt: null,
    updatedAt: null,
    content,
    contentHash,
    artifactKey: `page:${source.id}`,
    metadata: {
      baseline: previousBody === null,
      changedBlocks: changedBlocks.length,
    },
  };

  return {
    notModified: false,
    items: [item],
    etag: response.etag,
    lastModified: response.lastModified,
    cursor: contentHash,
    snapshot: {
      body: response.body,
      contentType: response.contentType,
    },
  };
}

export async function collectOpenApi(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  const response = await fetchSource(env, source.url, state, {
    accept: "application/yaml, text/yaml, application/json, text/plain",
    maxBytes: 16_000_000,
  });
  if (response.notModified) return unchanged(response, state);

  const snapshotKey = `sources/${source.id}/latest`;
  const previous = await env.SNAPSHOTS.get(snapshotKey);
  const previousBody = previous ? await previous.text() : null;
  const contentHash = await sha256(response.body);
  const diff = semanticOpenApiDiff(previousBody, response.body);
  const item: CollectedItem = {
    sourceId: source.id,
    externalId: source.id,
    canonicalUrl: source.canonicalUrl,
    title: "Mistral public OpenAPI specification changed",
    publishedAt: null,
    updatedAt: null,
    content: diff.summary,
    contentHash,
    artifactKey: "openapi:mistral",
    metadata: diff.metadata,
  };

  return {
    notModified: false,
    items: [item],
    etag: response.etag,
    lastModified: response.lastModified,
    cursor: contentHash,
    snapshot: {
      body: response.body,
      contentType: response.contentType,
    },
  };
}

export function semanticOpenApiDiff(
  previousBody: string | null,
  nextBody: string,
): {
  summary: string;
  metadata: Record<string, JsonValue>;
} {
  if (!previousBody) {
    return {
      summary: "Initial OpenAPI baseline captured.",
      metadata: { baseline: true },
    };
  }

  const previous = parseDocument(previousBody);
  const next = parseDocument(nextBody);
  const previousOperations = operations(previous);
  const nextOperations = operations(next);
  const added = [...nextOperations.keys()].filter(
    (key) => !previousOperations.has(key),
  );
  const removed = [...previousOperations.keys()].filter(
    (key) => !nextOperations.has(key),
  );
  const changed = [...nextOperations.keys()].filter(
    (key) =>
      previousOperations.has(key) &&
      stableJson(previousOperations.get(key)) !==
        stableJson(nextOperations.get(key)),
  );

  const previousSchemas = schemas(previous);
  const nextSchemas = schemas(next);
  const changedSchemas = [...nextSchemas.keys()].filter(
    (key) =>
      !previousSchemas.has(key) ||
      stableJson(previousSchemas.get(key)) !== stableJson(nextSchemas.get(key)),
  );
  const removedSchemas = [...previousSchemas.keys()].filter(
    (key) => !nextSchemas.has(key),
  );
  const lines = [
    ...added.map((value) => `Added operation: ${value}`),
    ...removed.map((value) => `Removed operation: ${value}`),
    ...changed.map((value) => `Changed operation: ${value}`),
    ...changedSchemas.map((value) => `Changed schema: ${value}`),
    ...removedSchemas.map((value) => `Removed schema: ${value}`),
  ];

  return {
    summary:
      lines.slice(0, 150).join("\n") ||
      "The specification changed without an endpoint or component-schema change.",
    metadata: {
      baseline: false,
      counts: {
        addedOperations: added.length,
        removedOperations: removed.length,
        changedOperations: changed.length,
        changedSchemas: changedSchemas.length,
        removedSchemas: removedSchemas.length,
      },
      addedOperations: added.slice(0, 200),
      removedOperations: removed.slice(0, 200),
      changedOperations: changed.slice(0, 200),
      changedSchemas: changedSchemas.slice(0, 200),
      removedSchemas: removedSchemas.slice(0, 200),
    },
  };
}

function parseDocument(body: string): Record<string, unknown> {
  const parsed = parseYaml(body) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("OpenAPI source did not parse to an object");
  }
  return parsed as Record<string, unknown>;
}

function operations(document: Record<string, unknown>): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const paths = document.paths as Record<string, unknown> | undefined;
  for (const [path, value] of Object.entries(paths ?? {})) {
    if (!value || typeof value !== "object") continue;
    for (const [method, operation] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (
        ["get", "post", "put", "patch", "delete", "options", "head"].includes(
          method.toLowerCase(),
        )
      ) {
        result.set(`${method.toUpperCase()} ${path}`, operation);
      }
    }
  }
  return result;
}

function schemas(document: Record<string, unknown>): Map<string, unknown> {
  const components = document.components as Record<string, unknown> | undefined;
  const definitions = components?.schemas as
    | Record<string, unknown>
    | undefined;
  return new Map(Object.entries(definitions ?? {}));
}

function extractMain(html: string): string {
  return (
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/iu)?.[1] ??
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/iu)?.[1] ??
    html
  );
}

function extractTextBlocks(html: string): string[] {
  const blocks = [
    ...html.matchAll(
      /<(?:h1|h2|h3|h4|p|li)\b[^>]*>([\s\S]*?)<\/(?:h1|h2|h3|h4|p|li)>/giu,
    ),
  ]
    .map((match) => cleanText(match[1] ?? "", 4_000))
    .filter((value) => value.length >= 3);
  return [...new Set(blocks)];
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
