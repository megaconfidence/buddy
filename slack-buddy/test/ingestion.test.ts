import { describe, expect, it, vi } from "vitest";
import { createSlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import { toSlackMessage } from "../src/slack/bot";
import {
  groupMessagesIntoThreads,
  scoreCandidateThreads,
} from "../src/domain/threads";

vi.mock("agents", () => ({ getAgentByName: vi.fn() }));
vi.mock("chat-state-cloudflare-do", () => ({ createCloudflareState: vi.fn() }));

describe("webhook ingestion", () => {
  it("preserves raw mention IDs after SDK parsing normalizes the display text", () => {
    const adapter = createSlackAdapter({
      botToken: "test",
      signingSecret: "test",
    });
    const raw = {
      type: "message",
      channel: "C1",
      ts: "100.000001",
      user: "U1",
      text: "Could <@UOWNER> help?",
    } as SlackEvent;
    const parsed = adapter.parseMessage(raw);
    expect(parsed.text).not.toContain("<@UOWNER>");
    const stored = toSlackMessage("T1", "C1", raw.ts!, raw, parsed);
    const threads = groupMessagesIntoThreads([
      { ...stored, channelName: "dev", userName: "Ada", isBot: false },
    ]);
    expect(scoreCandidateThreads(threads, "UOWNER")[0]?.mustShow).toBe(true);
  });
});
