import { McpFailure, type ToolResult } from "./client";

export type Source = {
  id: string;
  channelId: string;
  channelName: string;
  messageTs: string;
  threadTs: string;
  url: string;
  text: string;
  postedAt: number;
  mention: boolean;
};
export type SearchPage = {
  sources: Source[];
  cursor: string | null;
  partial: boolean;
};
export function envelope(result: ToolResult): Record<string, unknown> {
  if (result.isError) throw new McpFailure("tool_error");
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    if (
      Array.isArray(result.structuredContent) ||
      JSON.stringify(result.structuredContent).length > 250_000
    )
      throw new McpFailure("format");
    return result.structuredContent as Record<string, unknown>;
  }
  const text = result.content
    ?.filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
  if (!text || text.length > 250_000) throw new McpFailure("format");
  try {
    const json: unknown = JSON.parse(text);
    if (json && typeof json === "object" && !Array.isArray(json))
      return json as Record<string, unknown>;
  } catch {}
  throw new McpFailure("format");
}
export function pagination(value: unknown): {
  cursor: string | null;
  partial: boolean;
} {
  if (value === undefined || value === null || value === "")
    return { cursor: null, partial: false };
  if (typeof value === "object") {
    const p = value as Record<string, unknown>;
    const cursor = typeof p.next_cursor === "string" ? p.next_cursor : null;
    return { cursor: cursor || null, partial: Boolean(p.has_more) && !cursor };
  }
  if (typeof value !== "string") return { cursor: null, partial: true };
  // The gateway returns prose, including `cursor=...` for another page.
  const match = value.match(
    /(?:next_cursor|cursor)(?:\s*(?:=|:)\s*|\s+)["'`]?([A-Za-z0-9+/=_-]+)/i,
  );
  if (match?.[1]) return { cursor: match[1], partial: false };
  if (
    /no more|no additional|all (?:results|messages)|end of|0 results/i.test(
      value,
    )
  )
    return { cursor: null, partial: false };
  return { cursor: null, partial: true };
}
function sourceUrl(raw: string, channel: string, ts: string): string | null {
  if (raw.length > 500) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname) ||
      url.username ||
      url.password
    )
      return null;
    if (url.pathname !== `/archives/${channel}/p${ts.replace(".", "")}`)
      return null;
    // Retain only the link and optional thread identity, never arbitrary query values.
    const thread = url.searchParams.get("thread_ts");
    url.search = "";
    url.hash = "";
    if (thread && /^\d+\.\d+$/.test(thread))
      url.searchParams.set("thread_ts", thread);
    return url.toString();
  } catch {
    return null;
  }
}
export function parseSearch(
  result: ToolResult,
  owner: string,
  start: number,
  end: number,
): SearchPage {
  const data = envelope(result);
  if (typeof data.results !== "string") throw new McpFailure("format");
  const text = data.results;
  const headers = [
    ...text.matchAll(
      /^Channel:\s*(.*?)\s*\(ID:\s*([CG][A-Z0-9]+)\)\s*\r?\nFrom:[^\n]*\r?\nTime:[^\n]*\r?\nMessage_ts:\s*(\d+\.\d+)\s*$/gm,
    ),
  ];
  const sources: Source[] = [];
  let malformed = false;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const body = text.slice(
      h.index! + h[0].length,
      headers[i + 1]?.index ?? text.length,
    );
    const messageTs = h[3]!;
    const channelId = h[2]!;
    const postedAt = Math.round(Number(messageTs) * 1000);
    const link = body.match(
      /^Permalink:\s*\[[^\]]*\]\((https:\/\/[^\s)]+)\)/m,
    )?.[1];
    const url = link ? sourceUrl(link, channelId, messageTs) : null;
    const sourceText = body
      .match(/^Text:\s*\n?([\s\S]*)/m)?.[1]
      ?.replace(/\n### [^\n]*\s*$/, " ")
      .trim();
    if (!url || !sourceText) {
      malformed = true;
      continue;
    }
    if (postedAt < start || postedAt >= end) continue;
    const threadTs =
      body.match(/^(?:Thread_ts|Thread TS):\s*(\d+\.\d+)/m)?.[1] ??
      new URL(url).searchParams.get("thread_ts") ??
      messageTs;
    sources.push({
      id: `${channelId}:${messageTs}`,
      channelId,
      channelName: h[1]!.replace(/^#/, "").slice(0, 80),
      messageTs,
      threadTs,
      url,
      text: sourceText.slice(0, 4500),
      postedAt,
      mention: sourceText.includes(`<@${owner}>`),
    });
    if (sourceText.length > 4500) malformed = true;
  }
  const reported = text.match(/^## Messages \((\d+) results?\)/m)?.[1];
  if (
    headers.length === 0 &&
    !/no (?:search )?results|no messages|0 results/i.test(text)
  )
    throw new McpFailure("format");
  if (reported && Number(reported) !== headers.length) malformed = true;
  return {
    sources,
    ...pagination(data.pagination_info),
    partial: malformed || pagination(data.pagination_info).partial,
  };
}
export function parseThread(
  result: ToolResult,
  end: number,
): { text: string; partial: boolean } {
  const data = envelope(result);
  if (typeof data.messages !== "string") throw new McpFailure("format");
  // Enforce the end bound again; the connector's API uses inclusive limits.
  const blocks = data.messages.split(/(?=^=== .+ ===\s*$)/m).filter(Boolean);
  const selected = blocks.filter((block) => {
    const ts = block.match(/^Message TS:\s*(\d+\.\d+)/m)?.[1];
    return ts !== undefined && Number(ts) * 1000 < end;
  });
  if (
    !selected.length &&
    data.messages.trim() &&
    !/no messages/i.test(data.messages)
  )
    throw new McpFailure("format");
  const text = selected.join("\n");
  const p = pagination(data.pagination_info);
  return {
    text: text.slice(0, 6000),
    partial: text.length > 6000 || Boolean(p.cursor) || p.partial,
  };
}
