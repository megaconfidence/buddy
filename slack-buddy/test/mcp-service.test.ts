import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "./helpers/database";
import type { Env } from "../src/env";
import { SlackMcp } from "../src/mcp/client";
import { AppStore } from "../src/mcp/store";
import { DEFAULT_SETTINGS } from "../src/mcp/settings";
import {
  deliveryPages,
  scheduledBriefing,
  sendBriefing,
} from "../src/mcp/service";
import type { Briefing, BriefingItem } from "../src/mcp/model";

let database: ReturnType<typeof testDatabase>, env: Env, store: AppStore;
const window = {
  start: Date.parse("2026-09-09T22:00:00Z"),
  end: Date.parse("2026-09-10T22:00:00Z"),
};
const briefing: Briefing = { overview: "No selected items.", items: [] };
beforeEach(() => {
  database = testDatabase();
  env = {
    DB: database.db,
    SLACK_USER_ID: "UOWNER",
    MISTRAL_API_KEY: "test",
  } as Env;
  store = new AppStore(env.DB, env.SLACK_USER_ID);
  vi.spyOn(SlackMcp.prototype, "close").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

describe("MCP service delivery and scheduled execution", () => {
  it("never retries an ambiguous send, including a new HTTP request", async () => {
    const send = vi
      .spyOn(SlackMcp.prototype, "send")
      .mockRejectedValue(new Error("connection lost after posting"));
    await store.begin("run-1", "briefing");
    await store.finish("run-1", 3, 8, false);
    await expect(
      sendBriefing(env, "run-1", briefing, window, false),
    ).rejects.toThrow("delivery_uncertain");
    await expect(
      sendBriefing(env, "run-1", briefing, window, false),
    ).rejects.toThrow("delivery_already_attempted");
    expect(send).toHaveBeenCalledTimes(1);
    expect((await store.runs())[0]).toMatchObject({
      delivery_status: "uncertain",
    });
  });
  it("records delivery only after all pages succeed and always targets the owner", async () => {
    const send = vi
      .spyOn(SlackMcp.prototype, "send")
      .mockResolvedValue({ content: [{ type: "text", text: '{"ok":true}' }] });
    await store.begin("run-2", "briefing");
    await store.finish("run-2", 3, 8, false);
    expect(await sendBriefing(env, "run-2", briefing, window, false)).toEqual({
      sent: 1,
      pages: 1,
    });
    expect(send).toHaveBeenCalledWith(
      "UOWNER",
      expect.stringContaining("2026-09-10"),
    );
    expect((await store.runs())[0]).toMatchObject({ delivery_status: "sent" });
  });
  it("keeps worst-case multipart messages within the gateway's 5000-character limit", () => {
    const item: BriefingItem = {
      section: "content",
      title: "t".repeat(140),
      summary: "s".repeat(700),
      why: "w".repeat(350),
      nextStep: "n".repeat(300),
      sourceIds: ["s"],
      sources: Array.from({ length: 4 }, () => ({
        id: "s",
        url: "https://example.slack.com/" + "x".repeat(470),
        channelName: "c".repeat(80),
      })),
      evidence: "evidence",
      certainty: "tentative",
      audience: "a".repeat(160),
      format: "f".repeat(80),
    };
    const pages = deliveryPages(
      { overview: "", items: Array.from({ length: 60 }, () => item) },
      window,
      true,
    );
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.length <= 5000)).toBe(true);
    expect(pages.every((p) => p.includes(item.title))).toBe(true);
  });
  it("keeps the connector idle when scheduling is off and never repeats a daily run", async () => {
    const read = vi.spyOn(SlackMcp.prototype, "read").mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"results":"## Messages (0 results)","pagination_info":"There are no more results."}',
        },
      ],
    });
    const send = vi
      .spyOn(SlackMcp.prototype, "send")
      .mockResolvedValue({ content: [{ type: "text", text: '{"ok":true}' }] });
    await store.save({ ...DEFAULT_SETTINGS, dailyDelivery: true }, 0);
    const now = Date.parse("2026-09-11T06:00:00Z");
    await scheduledBriefing(env, now);
    expect(read).not.toHaveBeenCalled();
    env.SLACK_BUDDY_SCHEDULED_MCP_ENABLED = "true";
    await scheduledBriefing(env, now - 3600_000);
    expect(read).not.toHaveBeenCalled();
    await scheduledBriefing(env, now);
    const calls = read.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(send).toHaveBeenCalledTimes(1);
    await scheduledBriefing(env, now + 3600_000);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("marks expired executions interrupted while preserving a current run", async () => {
    await store.begin("old", "briefing");
    database.sqlite
      .prepare("UPDATE mcp_runs SET started_at=? WHERE id='old'")
      .run(Date.now() - 300_000);
    database.sqlite.prepare("UPDATE mcp_locks SET expires_at=0").run();
    await store.begin("new", "briefing");
    const runs = await store.runs();
    expect(runs.find((r) => r.id === "old")).toMatchObject({
      status: "failed",
      error_code: "interrupted",
    });
    expect(runs.find((r) => r.id === "new")).toMatchObject({
      status: "running",
    });
  });
});
