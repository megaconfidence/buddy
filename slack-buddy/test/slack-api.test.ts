import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callSlackApi } from "../src/slack/client";
import {
  deliverDigest,
  ensurePublicChannelMembership,
  reconcileChannelHistory,
  type HistoryReconciliationPage,
} from "../src/slack/api";
import { SlackBuddyRepository } from "../src/storage/repository";
import type { Env } from "../src/env";
import { testDatabase } from "./helpers/database";
import { digest, item, now, timestamp, window } from "./helpers/fixtures";

let database: ReturnType<typeof testDatabase>;
let env: Env;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  database = testDatabase();
  env = {
    DB: database.db,
    SLACK_BOT_TOKEN: "test",
    SLACK_USER_ID: "U1",
    SLACK_BUDDY_RETENTION_DAYS: "14",
    SLACK_BUDDY_AUTO_JOIN_PUBLIC_CHANNELS: "true",
  } as Env;
});
afterEach(() => {
  database.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mockSlack(handle: (method: string, body: URLSearchParams) => unknown) {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const response = handle(
      new URL(String(url)).pathname.split("/").at(-1)!,
      new URLSearchParams(String(init?.body)),
    );
    return response instanceof Response ? response : Response.json(response);
  });
  vi.stubGlobal("fetch", request);
  return request;
}

describe("Slack API validation and recovery", () => {
  it("rejects HTTP-200 Slack errors rather than checkpointing empty history", async () => {
    mockSlack(() => ({ ok: false, error: "missing_scope" }));
    await expect(
      reconcileChannelHistory({
        env,
        teamId: "T1",
        channel: { id: "C1" },
        startMs: window.startMs,
        endMs: window.endMs,
      }),
    ).rejects.toThrow("missing_scope");
  });

  it("does not record rejected channel joins as accessible channels", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSlack((method) =>
      method === "conversations.list"
        ? { ok: true, channels: [{ id: "C1", is_member: false }] }
        : { ok: false, error: "restricted_action" },
    );
    expect(await ensurePublicChannelMembership(env, "T1")).toEqual([]);
    expect(
      database.sqlite.prepare("SELECT * FROM slack_channels").all(),
    ).toEqual([]);
  });

  it("respects Retry-After and bounds the number of rate-limit retries", async () => {
    const request = mockSlack(() =>
      Response.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "retry-after": "4" } },
      ),
    );
    const pending = callSlackApi(
      "conversations.history",
      {},
      { token: "test" },
    );
    const failure = expect(pending).rejects.toThrow("429");
    await vi.advanceTimersByTimeAsync(3_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    await failure;
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("also retries HTTP-200 ratelimited responses, but never ambiguous failed writes", async () => {
    let attempts = 0;
    mockSlack(() =>
      ++attempts === 1
        ? { ok: false, error: "ratelimited", retry_after: 2 }
        : { ok: true },
    );
    const pending = callSlackApi("conversations.list", {}, { token: "test" });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ ok: true });
    const request = mockSlack(() =>
      Response.json({ ok: false, error: "internal_error" }, { status: 500 }),
    );
    await expect(
      callSlackApi("chat.postMessage", {}, { token: "test" }),
    ).rejects.toThrow("500");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not shorten Retry-After intervals longer than one minute", async () => {
    let attempts = 0;
    const request = mockSlack(() =>
      ++attempts === 1
        ? Response.json(
            { ok: false, error: "ratelimited" },
            { status: 429, headers: { "retry-after": "90" } },
          )
        : { ok: true },
    );
    const pending = callSlackApi("conversations.list", {}, { token: "test" });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("discovers replies on older parent pages and retains only allowed context", async () => {
    const old = timestamp(now - 7 * 86_400_000);
    const expired = timestamp(now - 30 * 86_400_000);
    const reply = timestamp(window.startMs + 1_000);
    const secondReply = timestamp(window.startMs + 2_000);
    mockSlack((method, body) => {
      if (method === "conversations.history") {
        expect(body.has("oldest")).toBe(false);
        return body.get("cursor")
          ? {
              ok: true,
              messages: [
                {
                  ts: expired,
                  text: "Expired root",
                  reply_count: 1,
                  latest_reply: secondReply,
                },
              ],
            }
          : {
              ok: true,
              messages: [
                {
                  ts: old,
                  text: "Retained context",
                  reply_count: 1,
                  latest_reply: reply,
                },
              ],
              response_metadata: { next_cursor: "older" },
            };
      }
      expect(method).toBe("conversations.replies");
      expect(Number(body.get("oldest")) * 1_000).toBe(now - 14 * 86_400_000);
      const root = body.get("ts")!;
      return {
        ok: true,
        messages: [
          {
            ts: root,
            thread_ts: root,
            text: root === old ? "Retained context" : "Expired root",
          },
          {
            ts: root === old ? reply : secondReply,
            thread_ts: root,
            text: "<@UOWNER> please review",
          },
        ],
      };
    });
    await reconcileChannelHistory({
      env,
      teamId: "T1",
      channel: { id: "C1" },
      startMs: window.startMs,
      endMs: window.endMs,
    });
    const messages = await new SlackBuddyRepository(env.DB).loadMessages(
      "T1",
      window.startMs,
      window.endMs,
    );
    expect(messages.map((m) => m.messageTs)).toEqual([old, reply, secondReply]);
    expect(messages.find((m) => m.messageTs === secondReply)?.threadTs).toBe(
      expired,
    );
  });

  it("recovers a partially delivered multi-message digest without duplicate posts", async () => {
    const sent: Array<{ ts: string; blocks: unknown[] }> = [];
    let failSecond = true;
    const request = mockSlack((method, body) => {
      if (method === "conversations.open")
        return { ok: true, channel: { id: "D1" } };
      if (method === "conversations.history")
        return { ok: true, messages: sent };
      if (method === "chat.update")
        return { ok: true, channel: "D1", ts: body.get("ts") };
      expect(method).toBe("chat.postMessage");
      if (sent.length === 1 && failSecond) {
        failSecond = false;
        return Response.json(
          { ok: false, error: "internal_error" },
          { status: 500 },
        );
      }
      const blocks = JSON.parse(body.get("blocks")!) as Array<{
        type: string;
        elements?: Array<{ action_id: string; value: string }>;
      }>;
      expect(blocks.length).toBeLessThanOrEqual(50);
      for (const block of blocks.filter((b) => b.type === "actions")) {
        expect(new Set(block.elements!.map((e) => e.action_id)).size).toBe(3);
        expect(
          block.elements!.every(
            (e) => JSON.parse(e.value).digestId === "digest-1",
          ),
        ).toBe(true);
      }
      const ts = `${sent.length + 1}.000001`;
      sent.push({ ts, blocks });
      return { ok: true, channel: "D1", ts };
    });
    const input = {
      env,
      digestId: "digest-1",
      teamId: "T1",
      window,
      digest: digest(
        Array.from({ length: 35 }, (_, i) =>
          item(`C${i}`, { id: `item-${i}`, mustShow: true }),
        ),
      ),
      existingChannelId: null,
      existingMessageTs: null,
    };
    await expect(deliverDigest(input)).rejects.toThrow("500");
    expect(sent).toHaveLength(1);
    await expect(deliverDigest(input)).resolves.toEqual({
      channelId: "D1",
      messageTs: "1.000001",
    });
    expect(sent).toHaveLength(3);
    expect(
      sent
        .flatMap((p) => p.blocks)
        .filter((b) => (b as { type: string }).type === "actions"),
    ).toHaveLength(35);
    expect(
      request.mock.calls.filter(([url]) => String(url).endsWith("chat.update")),
    ).toHaveLength(1);
  });

  it("resumes history scans from checkpointed pages without storing raw text in checkpoints", async () => {
    let fail = true;
    let firstPageRequests = 0;
    mockSlack((_method, body) => {
      if (!body.get("cursor")) {
        firstPageRequests += 1;
        return {
          ok: true,
          messages: [
            { ts: timestamp(window.startMs + 1_000), text: "Source text" },
          ],
          response_metadata: { next_cursor: "second" },
        };
      }
      if (fail) {
        fail = false;
        return { ok: false, error: "internal_error" };
      }
      return { ok: true, messages: [] };
    });
    const pages = new Map<string, HistoryReconciliationPage>();
    const input = {
      env,
      teamId: "T1",
      channel: { id: "C1" },
      startMs: window.startMs,
      endMs: window.endMs,
      checkpoint: async (
        name: string,
        work: () => Promise<HistoryReconciliationPage>,
      ) => {
        const saved = pages.get(name);
        if (saved) return saved;
        const result = await work();
        pages.set(name, structuredClone(result));
        return result;
      },
    };
    await expect(reconcileChannelHistory(input)).rejects.toThrow(
      "internal_error",
    );
    expect([...pages.keys()]).toEqual(["reconcile C1 page 1"]);
    expect(JSON.stringify([...pages.values()])).not.toContain("Source text");
    await expect(reconcileChannelHistory(input)).resolves.toMatchObject({
      messageCount: 1,
    });
    expect(firstPageRequests).toBe(1);
  });
});
