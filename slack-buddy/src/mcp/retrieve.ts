import { McpFailure, type SlackReader } from "./client";
import { parseSearch, parseThread, type Source } from "./normalize";
import { planSearches, type Settings, type SearchPlan } from "./settings";

export type Coverage = {
  label: string;
  scope: string;
  status: "searched" | "partial" | "failed" | "skipped";
  matches: number;
  reason?: string;
};
export type Retrieval = {
  sources: Source[];
  coverage: Coverage[];
  requests: number;
  elapsedMs: number;
  partial: boolean;
};
export async function retrieve(
  reader: SlackReader,
  settings: Settings,
  owner: string,
  start: number,
  end: number,
  options: {
    plan?: SearchPlan[];
    maxRequests?: number;
    maxMs?: number;
    now?: () => number;
  } = {},
): Promise<Retrieval> {
  const now = options.now ?? Date.now;
  const began = now();
  const maxRequests = options.maxRequests ?? 10;
  const maxMs = options.maxMs ?? 65_000;
  const plan = options.plan ?? planSearches(settings, owner, end);
  const coverage: Coverage[] = [];
  const found = new Map<string, Source>();
  let requests = 0;
  let stopped = false;
  const available = () =>
    !stopped && requests < maxRequests && now() - began < maxMs;
  for (const search of plan) {
    if (!available()) {
      coverage.push({
        label: search.label,
        scope: search.scope,
        status: "skipped",
        matches: 0,
        reason: "Request or time budget reached",
      });
      continue;
    }
    const result: Coverage = {
      label: search.label,
      scope: search.scope,
      status: "searched",
      matches: 0,
    };
    coverage.push(result);
    const usePrivate =
      search.scope === "joined" && settings.includePrivateChannels;
    const name = usePrivate
      ? "slack_search_public_and_private"
      : "slack_search_public";
    const args: Record<string, unknown> = {
      query: search.query,
      content_types: "messages",
      after: (start / 1000).toFixed(6),
      before: (end / 1000).toFixed(6),
      limit: 20,
      sort: search.mentions ? "timestamp" : "score",
      response_format: "detailed",
      include_context: false,
      only_my_channels: search.scope === "joined",
      ...(usePrivate
        ? { channel_types: "public_channel,private_channel" }
        : {}),
    };
    try {
      requests++;
      let page = parseSearch(await reader.read(name, args), owner, start, end);
      for (const s of page.sources) found.set(s.id, s);
      result.matches += page.sources.length;
      if (page.partial) result.status = "partial";
      // Reserve one extra page for mentions; do not paginate every topical search.
      if (
        search.mentions &&
        page.cursor &&
        available() &&
        maxRequests - requests > plan.length
      ) {
        requests++;
        page = parseSearch(
          await reader.read(name, { ...args, cursor: page.cursor }),
          owner,
          start,
          end,
        );
        for (const s of page.sources) found.set(s.id, s);
        result.matches += page.sources.length;
      }
      if (page.cursor || page.partial) {
        result.status = "partial";
        result.reason = "More matches or truncated context remain";
      }
    } catch (e) {
      result.status = "failed";
      result.reason = e instanceof McpFailure ? e.code : "tool_error";
      if (result.reason === "authentication" || result.reason === "rate_limit")
        stopped = true;
    }
  }
  const ranked = [...found.values()].sort(
    (a, b) => Number(b.mention) - Number(a.mention) || b.postedAt - a.postedAt,
  );
  const sources: Source[] = [];
  let characters = 0;
  for (const s of ranked) {
    if (characters + s.text.length > 48_000) break;
    sources.push(s);
    characters += s.text.length;
  }
  if (sources.length < found.size)
    coverage.push({
      label: "Context budget",
      scope: "all",
      status: "partial",
      matches: sources.length,
      reason: "Some retrieved matches did not fit in the model context",
    });
  const expanded = new Set<string>();
  for (const source of sources) {
    if (!available() || expanded.size >= 2) break;
    const key = `${source.channelId}:${source.threadTs}`;
    if (expanded.has(key)) continue;
    expanded.add(key);
    try {
      requests++;
      const extra = parseThread(
        await reader.read("slack_read_thread", {
          channel_id: source.channelId,
          message_ts: source.threadTs,
          limit: 20,
          latest: (end / 1000).toFixed(6),
          response_format: "detailed",
        }),
        end,
      );
      source.text += `\nEarlier thread context (not necessarily new activity):\n${extra.text}`;
      if (extra.partial)
        coverage.push({
          label: "Thread context",
          scope: source.channelName,
          status: "partial",
          matches: 1,
          reason: "Thread context was limited",
        });
    } catch (e) {
      coverage.push({
        label: "Thread context",
        scope: source.channelName,
        status: "partial",
        matches: 0,
        reason: e instanceof McpFailure ? e.code : "tool_error",
      });
      if (
        e instanceof McpFailure &&
        ["authentication", "rate_limit"].includes(e.code)
      )
        stopped = true;
    }
  }
  return {
    sources,
    coverage,
    requests,
    elapsedMs: now() - began,
    partial: coverage.some((c) => c.status !== "searched"),
  };
}
