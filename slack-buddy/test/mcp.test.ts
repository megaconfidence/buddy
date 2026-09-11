import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS, planSearches } from "../src/mcp/settings";
import { parseSearch, parseThread, pagination } from "../src/mcp/normalize";
import { retrieve } from "../src/mcp/retrieve";
import { McpFailure, type ToolResult } from "../src/mcp/client";
import { groundBriefing } from "../src/mcp/model";
import { AppStore } from "../src/mcp/store";
import { testDatabase } from "./helpers/database";

const start = Date.parse("2026-09-10T00:00:00Z"),
  end = start + 86400_000;
const ts = ((start + 1000) / 1000).toFixed(6);
function result(
  text: string,
  pagination_info = "There are no more results.",
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ results: text, pagination_info }),
      },
    ],
  };
}
function search(text = "OCR needs a tutorial", stamp = ts) {
  return result(
    `# Search Results for: OCR\n\n## Messages (1 result)\n### Result 1\nChannel: #ocr (ID: C123)\nFrom: Owner (ID: U123)\nTime: today\nMessage_ts: ${stamp}\nPermalink: [View](https://example.slack.com/archives/C123/p${stamp.replace(".", "")})\nText: \n${text}`,
  );
}
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

describe("MCP retrieval contracts", () => {
  it("keeps focus topics, mentions, and a separate public radar on every plan", () => {
    const plan = planSearches(DEFAULT_SETTINGS, "UOWNER", end);
    expect(plan.map((p) => p.query)).toContain("OCR");
    expect(plan.map((p) => p.query)).toContain("Vibe");
    expect(plan.some((p) => p.mentions)).toBe(true);
    expect(plan.some((p) => p.scope === "public")).toBe(true);
    expect(plan.map((p) => p.query)).toContain("document extraction");
    expect(plan.map((p) => p.query)).toContain("coding agent");
    const many = {
      ...DEFAULT_SETTINGS,
      priorities: Array.from({ length: 5 }, (_, i) => ({
        name: `Topic ${i}`,
        keywords: [`primary ${i}`, `alias ${i}`],
      })),
    };
    const crowded = planSearches(many, "UOWNER", end);
    expect(crowded).toHaveLength(8);
    expect(crowded.filter((p) => p.scope === "public")).toHaveLength(1);
    expect(crowded.filter((p) => p.query.startsWith("primary"))).toHaveLength(
      5,
    );
  });
  it("normalizes actual gateway text, enforces the time window, and rejects forged non-Slack links", () => {
    expect(
      parseSearch(search(), "UOWNER", start, end).sources[0],
    ).toMatchObject({
      channelId: "C123",
      messageTs: ts,
      text: "OCR needs a tutorial",
    });
    expect(
      parseSearch(search("new", (end / 1000).toFixed(6)), "UOWNER", start, end)
        .sources,
    ).toEqual([]);
    const forged = search();
    forged.content![0]!.text = forged.content![0]!.text!.replace(
      "example.slack.com",
      "example.slack.com.evil.test",
    );
    expect(parseSearch(forged, "UOWNER", start, end)).toMatchObject({
      sources: [],
      partial: true,
    });
    expect(() =>
      parseSearch(
        result("A completely different output format"),
        "UOWNER",
        start,
        end,
      ),
    ).toThrow("format");
  });
  it("never treats unknown pagination as complete", () => {
    expect(pagination("Next page: use cursor=abc123==")).toEqual({
      cursor: "abc123==",
      partial: false,
    });
    expect(
      pagination("For the next page of results use cursor `abc123==`\n"),
    ).toEqual({ cursor: "abc123==", partial: false });
    expect(pagination("There are no more messages to fetch.")).toEqual({
      cursor: null,
      partial: false,
    });
    expect(pagination("Additional results available")).toEqual({
      cursor: null,
      partial: true,
    });
  });
  it("constrains private search to joined channels, excludes DMs, and reports exhausted budgets", async () => {
    const read = vi.fn(async () => search());
    const r = await retrieve({ read }, DEFAULT_SETTINGS, "UOWNER", start, end, {
      maxRequests: 2,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]).toEqual([
      "slack_search_public_and_private",
      expect.objectContaining({
        only_my_channels: true,
        channel_types: "public_channel,private_channel",
        content_types: "messages",
      }),
    ]);
    expect(r.sources).toHaveLength(1);
    expect(r.partial).toBe(true);
    expect(r.coverage.some((c) => c.status === "skipped")).toBe(true);
  });
  it("stops after rate limiting instead of multiplying retries", async () => {
    const read = vi.fn(async () => {
      throw new McpFailure("rate_limit");
    });
    const r = await retrieve({ read }, DEFAULT_SETTINGS, "UOWNER", start, end);
    expect(read).toHaveBeenCalledTimes(1);
    expect(r.partial).toBe(true);
    expect(r.coverage[0]?.reason).toBe("rate_limit");
  });
  it("does not expand messages after the digest end and reports truncated threads", () => {
    const r: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            messages: `=== Parent Message ===\nFrom: owner\nTime: yesterday\nMessage TS: ${ts}\nold context\n=== Reply 1 ===\nFrom: owner\nTime: tomorrow\nMessage TS: ${(end / 1000).toFixed(6)}\nfuture`,
            pagination_info: "Next cursor: xyz",
          }),
        },
      ],
    };
    expect(parseThread(r, end)).toEqual({
      text: expect.stringContaining("old context"),
      partial: true,
    });
    expect(parseThread(r, end).text).not.toContain("future");
  });
  it("rejects fabricated evidence and preserves retrieved owner mentions", () => {
    const sources = parseSearch(
      search("<@UOWNER> OCR needs a tutorial"),
      "UOWNER",
      start,
      end,
    ).sources;
    const output = groundBriefing(
      {
        overview: "Unverified model claim",
        items: [
          {
            section: "upcoming",
            title: "Invented launch",
            summary: "Tomorrow",
            why: "Important",
            nextStep: "Prepare",
            sourceIds: [sources[0]!.id],
            evidence: "not present",
            certainty: "confirmed",
            audience: "",
            format: "",
          },
        ],
      },
      { sources, coverage: [], requests: 1, elapsedMs: 1, partial: false },
    );
    expect(output.items).toHaveLength(1);
    expect(output.items[0]?.section).toBe("attention");
    expect(output.overview).not.toContain("Unverified");
  });
});
describe("MCP state and delivery concurrency", () => {
  it("guards profile versions, concurrent runs, and non-idempotent delivery", async () => {
    const db = testDatabase();
    databases.push(db);
    const store = new AppStore(db.db, "U1");
    expect(
      (await store.settings()).settings.priorities.map((p) => p.name),
    ).toEqual(["OCR", "Vibe"]);
    await store.save(DEFAULT_SETTINGS, 0);
    await expect(store.save(DEFAULT_SETTINGS, 0)).rejects.toThrow(
      "settings_conflict",
    );
    await store.begin("run-1", "briefing");
    await expect(store.begin("run-2", "briefing")).rejects.toThrow("run_busy");
    await store.finish("run-1", 4, 20, false);
    expect(await store.deliveryIntent("run-1")).toBe(true);
    expect(await store.deliveryIntent("run-1")).toBe(false);
    await store.delivered("run-1", null, null, "uncertain");
    expect(await store.deliveryIntent("run-1")).toBe(false);
    await expect(store.begin("run-1", "briefing")).rejects.toThrow(
      "run_exists",
    );
    await store.begin("run-2", "briefing");
    expect(
      db.sqlite
        .prepare(
          "SELECT name FROM pragma_table_info('mcp_runs') WHERE name LIKE '%text%' OR name LIKE '%json%'",
        )
        .all(),
    ).toEqual([]);
  });
});
