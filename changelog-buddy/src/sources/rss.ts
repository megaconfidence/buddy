import { XMLParser } from "fast-xml-parser";
import { sha256, stableJson } from "../domain/hash";
import type {
  CollectedItem,
  CollectionResult,
  SourceDefinition,
  SourceState,
} from "../domain/types";
import type { Env } from "../env";
import { fetchSource } from "./http";
import { cleanText, parseDate, stringValue } from "./text";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "#text",
  textNodeName: "#text",
  trimValues: true,
});

export async function collectRss(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  const response = await fetchSource(env, source.url, state, {
    accept:
      "application/rss+xml, application/atom+xml, application/xml, text/xml",
  });
  if (response.notModified) {
    return {
      notModified: true,
      items: [],
      etag: response.etag ?? state.etag,
      lastModified: response.lastModified ?? state.lastModified,
      cursor: state.cursor,
    };
  }

  const document = parser.parse(response.body) as Record<string, unknown>;
  const candidates =
    "rss" in document ? rssEntries(document) : atomEntries(document);
  const unique = new Map<string, Omit<CollectedItem, "contentHash">>();
  for (const candidate of candidates.map((item) => ({
    ...item,
    sourceId: source.id,
  }))) {
    if (!unique.has(candidate.externalId)) {
      unique.set(candidate.externalId, candidate);
    }
  }

  const items = await Promise.all(
    [...unique.values()].map(async (item) => ({
      ...item,
      contentHash: await sha256(
        stableJson({
          title: item.title,
          content: item.content,
          updatedAt: item.updatedAt,
          metadata: item.metadata,
        }),
      ),
    })),
  );

  return {
    notModified: false,
    items,
    etag: response.etag,
    lastModified: response.lastModified,
    cursor:
      items
        .map((item) => item.updatedAt ?? item.publishedAt ?? 0)
        .sort((left, right) => right - left)[0]
        ?.toString() ?? state.cursor,
  };
}

function rssEntries(
  document: Record<string, unknown>,
): Array<Omit<CollectedItem, "contentHash">> {
  const rss = document.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  return records(channel?.item).flatMap((item) => {
    const link = stringValue(item.link);
    const externalId = stringValue(item.guid) || link;
    if (!externalId) return [];
    const publishedAt = parseDate(item.pubDate);
    return [
      {
        sourceId: "",
        externalId,
        canonicalUrl: link || externalId,
        title: cleanText(stringValue(item.title), 300),
        publishedAt,
        updatedAt: publishedAt,
        content: cleanText(
          stringValue(item["content:encoded"] ?? item.description),
        ),
        artifactKey: artifactFromUrl(link || externalId),
        metadata: {},
      },
    ];
  });
}

function atomEntries(
  document: Record<string, unknown>,
): Array<Omit<CollectedItem, "contentHash">> {
  const feed = document.feed as Record<string, unknown> | undefined;
  return records(feed?.entry).flatMap((entry) => {
    const linkValue = entry.link;
    const links = records(linkValue);
    const link =
      links
        .map((candidate) => String(candidate["@_href"] ?? ""))
        .find(Boolean) ?? "";
    const externalId = stringValue(entry.id) || link;
    if (!externalId) return [];
    return [
      {
        sourceId: "",
        externalId,
        canonicalUrl: link || externalId,
        title: cleanText(stringValue(entry.title), 300),
        publishedAt: parseDate(entry.published ?? entry.updated),
        updatedAt: parseDate(entry.updated),
        content: cleanText(stringValue(entry.content ?? entry.summary)),
        artifactKey: artifactFromUrl(link || externalId),
        metadata: {},
      },
    ];
  });
}

function artifactFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/u, "");
    return path ? `url:${path}` : null;
  } catch {
    return null;
  }
}

function records(value: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate) && typeof candidate === "object",
  );
}
