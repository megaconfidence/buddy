import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { rankThreads, synthesizeDigest } from "../src/ai/model";
import { DEFAULT_PROFILE } from "../src/domain/profile";
import {
  initialDigestJob,
  slackJobId,
  type SlackJobParams,
} from "../src/domain/jobs";
import type { Env } from "../src/env";
import { SlackJobRepository } from "../src/storage/jobs";
import { SlackBuddyRepository } from "../src/storage/repository";
import {
  executeSlackJobPhase,
  launchSlackJob,
  runSlackJob,
} from "../src/workflows/jobs";
import { testDatabase } from "./helpers/database";
import {
  digest,
  item,
  message,
  now,
  timestamp,
  window,
} from "./helpers/fixtures";

vi.mock("agents", () => ({ getAgentByName: vi.fn() }));
vi.mock("../src/ai/model", () => ({
  createSlackBuddyModel: vi.fn(),
  rankThreads: vi.fn(),
  synthesizeDigest: vi.fn(),
}));

let database: ReturnType<typeof testDatabase>;
let env: Env;
let jobs: SlackJobRepository;
let repository: SlackBuddyRepository;
let queue: Array<{ id: string; params: SlackJobParams }>;
let instances: Map<string, { status: string }>;
let requests: number;
let allRequests: number;
let checkpoints: Map<string, Map<string, unknown>>;
let requestHandler: (method: string, body: URLSearchParams) => unknown;
const root = () =>
  initialDigestJob({
    digestId: "digest-1",
    teamId: "T1",
    userId: "U1",
    window,
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(now);
  database = testDatabase();
  jobs = new SlackJobRepository(database.db);
  repository = new SlackBuddyRepository(database.db);
  queue = [];
  instances = new Map();
  requests = 0;
  allRequests = 0;
  checkpoints = new Map();
  env = {
    DB: database.db,
    SLACK_BOT_TOKEN: "test",
    SLACK_USER_ID: "U1",
    SLACK_BUDDY_RETENTION_DAYS: "14",
    SLACK_BUDDY_RECONCILE_HOURS: "48",
    SLACK_BUDDY_JOB_PHASES: "1",
    SLACK_BUDDY_AUTO_JOIN_PUBLIC_CHANNELS: "true",
    MISTRAL_MODEL: "test",
    DIGEST_WORKFLOW: {
      createBatch: vi.fn(
        async (options: Array<{ id: string; params: SlackJobParams }>) =>
          options.map((option) => {
            if (instances.has(option.id)) throw new Error("already_exists");
            queue.push(option);
            instances.set(option.id, { status: "queued" });
            return instanceHandle(option.id);
          }),
      ),
      get: vi.fn(async (id: string) => {
        if (!instances.has(id)) throw new Error("not_found");
        return instanceHandle(id);
      }),
    },
  } as unknown as Env;
  vi.mocked(getAgentByName).mockResolvedValue({
    configureForUser: vi.fn(async () => structuredClone(DEFAULT_PROFILE)),
  } as never);
  vi.mocked(rankThreads).mockResolvedValue([]);
  vi.mocked(synthesizeDigest).mockResolvedValue(digest([]));
  await repository.createDigestRun({
    id: "digest-1",
    teamId: "T1",
    userId: "U1",
    window,
  });
  requestHandler = (method) => {
    if (method === "users.list") return { ok: true, members: [] };
    if (method === "conversations.list") return { ok: true, channels: [] };
    if (method === "conversations.open")
      return { ok: true, channel: { id: "D1" } };
    if (method === "conversations.history") return { ok: true, messages: [] };
    if (method === "chat.postMessage")
      return { ok: true, channel: "D1", ts: "1.000001" };
    throw new Error(`Unexpected ${method}`);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      allRequests++;
      if (requests > 10_000)
        throw new Error("Too many subrequests by single Worker invocation");
      const result = requestHandler(
        new URL(String(url)).pathname.split("/").at(-1)!,
        new URLSearchParams(String(init?.body)),
      );
      return result instanceof Response ? result : Response.json(result);
    }),
  );
});
afterEach(() => {
  database.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function instanceHandle(id: string) {
  return {
    id,
    status: async () => ({ status: instances.get(id)!.status }),
    restart: async () => {
      checkpoints.delete(id);
      instances.set(id, { status: "queued" });
      queue.push({ id, params: (await jobs.get(id)).params });
    },
  };
}
function stepFor(id: string): WorkflowStep {
  const saved = checkpoints.get(id) ?? new Map<string, unknown>();
  checkpoints.set(id, saved);
  return {
    do: async (
      name: string,
      config: { retries: { limit: number } },
      work: () => Promise<unknown>,
    ) => {
      if (saved.has(name)) return saved.get(name);
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await work();
          saved.set(name, structuredClone(result));
          return result;
        } catch (error) {
          if (attempt >= config.retries.limit) throw error;
        }
      }
    },
  } as unknown as WorkflowStep;
}
async function runInstance(params: SlackJobParams) {
  const id = await slackJobId(params.runKey, params.sequence);
  // ONLY reset at an independent Workflow instance boundary, never per step.
  requests = 0;
  instances.set(id, { status: "running" });
  try {
    await runSlackJob(env, params, id, stepFor(id));
    instances.set(id, { status: "complete" });
  } catch (error) {
    instances.set(id, { status: "errored" });
    throw error;
  }
  return requests;
}
async function drain(params: SlackJobParams) {
  queue.push({ id: await slackJobId(params.runKey, params.sequence), params });
  const budgets: number[] = [];
  const ids: string[] = [];
  while (queue.length) {
    if (ids.length > 500) throw new Error("Unbounded chain");
    const job = queue.shift()!;
    ids.push(job.id);
    budgets.push(await runInstance(job.params));
  }
  return { budgets, ids };
}

describe("bounded Paid-plan Workflow jobs", () => {
  it("syncs a large paginated directory with fewer Workflow instances", async () => {
    env.SLACK_BUDDY_JOB_PHASES = "10";
    const fallback = requestHandler;
    requestHandler = (method, body) => {
      if (method === "users.list")
        return {
          ok: true,
          members: [{ id: body.get("cursor") ? "U2" : "U1", name: "Owner" }],
          response_metadata: {
            next_cursor: body.get("cursor") ? "" : "users-2",
          },
        };
      if (method === "conversations.list")
        return {
          ok: true,
          channels: Array.from({ length: 35 }, (_, i) => ({
            id: `C${body.get("cursor") ? 35 + i : i}`,
            is_member: false,
          })),
          response_metadata: {
            next_cursor: body.get("cursor") ? "" : "channels-2",
          },
        };
      if (method === "conversations.join") return { ok: true };
      return fallback(method, body);
    };
    const { budgets, ids } = await drain(root());
    expect(allRequests).toBeGreaterThan(100);
    expect(Math.max(...budgets)).toBeLessThanOrEqual(100);
    expect(ids.length).toBeLessThan(20);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      database.sqlite.prepare("SELECT * FROM slack_channels").all(),
    ).toHaveLength(70);
    expect(
      database.sqlite.prepare("SELECT * FROM slack_users").all(),
    ).toHaveLength(2);
    expect((await repository.getDigestRun("digest-1"))?.status).toBe(
      "completed",
    );
  });

  it("stays within 300 requests with every join rate limited twice and a phase retry", async () => {
    const attempts = new Map<string, number>();
    requestHandler = (method, body) => {
      expect(method).toBe("conversations.join");
      const id = body.get("channel")!;
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      return attempt % 3
        ? Response.json(
            { ok: false, error: "ratelimited" },
            { status: 429, headers: { "retry-after": "1" } },
          )
        : { ok: true };
    };
    vi.spyOn(
      repository.constructor.prototype as SlackBuddyRepository,
      "upsertChannels",
    ).mockRejectedValueOnce(new Error("transient D1 failure"));
    const input: SlackJobParams = {
      ...root(),
      phase: {
        kind: "membership",
        offset: 0,
        nextCursor: null,
        channels: Array.from({ length: 50 }, (_, i) => ({ id: `C${i}` })),
      },
    };
    const pending = runInstance(input);
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    for (let tick = 0; tick < 500 && !finished; tick++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(await pending).toBe(300);
    expect((await jobs.get(await slackJobId(input.runKey, 0))).status).toBe(
      "completed",
    );
  });

  it("paginates old parents and replies independently without persisting raw history in jobs", async () => {
    const old = timestamp(now - 7 * 86_400_000);
    const expired = timestamp(now - 30 * 86_400_000);
    const first = timestamp(window.startMs + 1000);
    const second = timestamp(window.startMs + 2000);
    const fallback = requestHandler;
    requestHandler = (method, body) => {
      if (method === "conversations.list")
        return { ok: true, channels: [{ id: "C1", is_member: true }] };
      if (method === "conversations.history" && body.get("channel") === "C1") {
        expect(body.has("oldest")).toBe(false);
        const ts = body.get("cursor") ? expired : old;
        return {
          ok: true,
          messages: [
            { ts, text: "RAW ROOT", reply_count: 2, latest_reply: second },
          ],
          response_metadata: { next_cursor: body.get("cursor") ? "" : "older" },
        };
      }
      if (method === "conversations.replies")
        return {
          ok: true,
          messages: [
            {
              ts:
                body.get("ts") === expired
                  ? timestamp(
                      window.startMs + (body.get("cursor") ? 4000 : 3000),
                    )
                  : body.get("cursor")
                    ? second
                    : first,
              thread_ts: body.get("ts"),
              text: "RAW REPLY <@U1>",
            },
          ],
          response_metadata: {
            next_cursor: body.get("cursor") ? "" : "replies-2",
          },
        };
      return fallback(method, body);
    };
    const { budgets } = await drain(root());
    expect(Math.max(...budgets)).toBeLessThanOrEqual(3);
    const messages = await repository.loadMessages(
      "T1",
      window.startMs,
      window.endMs,
    );
    expect(messages.map((m) => m.messageTs)).not.toContain(expired);
    expect(messages.some((m) => m.threadTs === expired)).toBe(true);
    const durable =
      JSON.stringify(
        database.sqlite.prepare("SELECT params_json FROM slack_jobs").all(),
      ) +
      JSON.stringify(
        database.sqlite
          .prepare("SELECT value_json FROM slack_job_artifacts")
          .all(),
      ) +
      JSON.stringify(
        [...checkpoints.values()].map((values) => [...values.values()]),
      );
    expect(durable).not.toContain("RAW ROOT");
    expect(durable).not.toContain("RAW REPLY");
  });

  it("ranks multiple batches in separate instances", async () => {
    for (let i = 0; i < 3; i++)
      await repository.ingestMessage(
        message({
          channelId: `C${i}`,
          messageTs: timestamp(window.startMs + i * 1000),
          threadTs: timestamp(window.startMs + i * 1000),
          eventId: `e${i}`,
          text: "documentation ".repeat(4000),
          postedAt: window.startMs + i * 1000,
        }),
      );
    await jobs.put(root().runKey, "profile", DEFAULT_PROFILE);
    const { ids } = await drain({ ...root(), phase: { kind: "prepare" } });
    expect(rankThreads).toHaveBeenCalledTimes(3);
    const ranked = await Promise.all(ids.map((id) => jobs.get(id)));
    expect(
      ranked.filter((job) => job.params.phase.kind === "rank"),
    ).toHaveLength(3);
    expect(
      JSON.stringify(
        database.sqlite
          .prepare(
            "SELECT value_json FROM slack_job_artifacts WHERE name LIKE 'batch:%'",
          )
          .all(),
      ),
    ).not.toContain("documentation");
  });

  it("persists a successor before a failed launch and never repeats completed parent work", async () => {
    const create = vi.mocked(env.DIGEST_WORKFLOW.createBatch);
    create.mockRejectedValue(new Error("Workflow service unavailable"));
    const input = {
      ...root(),
      phase: { kind: "users" as const, cursor: null },
    };
    await expect(runInstance(input)).rejects.toThrow(
      "Workflow service unavailable",
    );
    expect((await jobs.get(await slackJobId(input.runKey, 0))).status).toBe(
      "completed",
    );
    const pending = await jobs.listIncomplete("T1");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.params.sequence).toBe(1);
    expect((await repository.getDigestRun("digest-1"))?.status).not.toBe(
      "failed",
    );
    const total = allRequests;
    await runInstance(input);
    expect(allRequests).toBe(total);
    expect(await jobs.listIncomplete("T1")).toHaveLength(1);
  });

  it("recovers an ambiguous write from the start of paginated DM history and does not duplicate pages", async () => {
    const content = digest(
      Array.from({ length: 35 }, (_, i) =>
        item(`C${i}`, { id: `item-${i}`, mustShow: true }),
      ),
    );
    await repository.saveDigest({
      digestId: "digest-1",
      digest: content,
      markdown: "",
      model: "test",
      promptVersion: "test",
      inputMessageCount: 35,
    });
    const sent: Array<{ ts: string; blocks: unknown[] }> = [];
    let loseResponse = true;
    let posts = 0;
    requestHandler = (method, body) => {
      if (method === "conversations.open")
        return { ok: true, channel: { id: "D1" } };
      if (method === "conversations.history")
        return body.get("cursor")
          ? { ok: true, messages: [] }
          : {
              ok: true,
              messages: sent,
              response_metadata: { next_cursor: "older" },
            };
      if (method === "chat.update")
        return { ok: true, channel: "D1", ts: body.get("ts") };
      expect(method).toBe("chat.postMessage");
      posts++;
      const ts = `${sent.length + 1}.000001`;
      sent.push({ ts, blocks: JSON.parse(body.get("blocks")!) });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("connection lost after Slack accepted the post");
      }
      return { ok: true, channel: "D1", ts };
    };
    // The failing job begins at an older cursor, where a new post cannot be found.
    const input: SlackJobParams = {
      ...root(),
      phase: { kind: "deliver", page: 0, channelId: "D1", cursor: "older" },
    };
    await expect(runInstance(input)).rejects.toThrow("connection lost");
    expect(queue).toHaveLength(0); // avoid immediate write-retry chains
    expect(sent).toHaveLength(1);
    checkpoints.clear(); // Workflow restart, as performed by the hourly scheduler
    await drain(input);
    expect(posts).toBe(3);
    expect(sent).toHaveLength(3);
    expect((await repository.getDigestRun("digest-1"))?.slack_message_ts).toBe(
      "1.000001",
    );
    expect((await repository.getDigestRun("digest-1"))?.status).toBe(
      "completed",
    );
    await runInstance(input);
    expect(posts).toBe(3);
    expect((await repository.getDigestRun("digest-1"))?.status).toBe(
      "completed",
    );
  });

  it("rejects mismatched instance IDs before doing external work", async () => {
    await expect(
      runSlackJob(env, root(), "old-monolithic-id", stepFor("bad")),
    ).rejects.toThrow("identity");
    expect(allRequests).toBe(0);
  });
  it("prunes completed chains but preserves all metadata for active chains", async () => {
    const complete = await jobs.enqueue(root());
    await jobs.put(complete.params.runKey, "profile", DEFAULT_PROFILE);
    await jobs.finish(complete.id, null);
    const active = await jobs.enqueue({ ...root(), runKey: "active" });
    await jobs.put(active.params.runKey, "profile", DEFAULT_PROFILE);
    await jobs.finish(active.id, {
      ...active.params,
      sequence: 1,
      phase: { kind: "users", cursor: null },
    });
    await jobs.deleteExpiredCompletedRuns(now + 1);
    await expect(jobs.get(complete.id)).rejects.toThrow("Missing Slack job");
    expect(await jobs.find(complete.params.runKey, "profile")).toBeNull();
    expect((await jobs.get(active.id)).status).toBe("completed");
    expect(await jobs.find(active.params.runKey, "profile")).not.toBeNull();
    expect(await jobs.listIncomplete("T1")).toHaveLength(1);
  });
  it("leaves a fast-failing child for scheduled recovery instead of immediately restarting it", async () => {
    const job = await jobs.enqueue(root());
    const restart = vi.fn();
    vi.mocked(env.DIGEST_WORKFLOW.createBatch).mockResolvedValue([
      { id: job.id, status: async () => ({ status: "errored" }), restart },
    ] as unknown as WorkflowInstance[]);
    await repository.markDigestFailed("digest-1", "Slack unavailable");
    await launchSlackJob(env, job);
    expect(restart).not.toHaveBeenCalled();
    expect((await repository.getDigestRun("digest-1"))?.status).toBe("failed");
    await launchSlackJob(env, job, true);
    expect(restart).toHaveBeenCalledOnce();
  });
  it("reuses a fresh directory snapshot without listing users or channels", async () => {
    await jobs.put("directory-snapshot", "channel:C1", {
      id: "C1",
      is_member: true,
    });
    await jobs.recordDirectory("T1", "directory-snapshot");
    const methods: string[] = [];
    const fallback = requestHandler;
    requestHandler = (method, body) => {
      methods.push(method);
      return fallback(method, body);
    };
    await drain(root());
    expect(methods).not.toContain("users.list");
    expect(methods).not.toContain("conversations.list");
    expect(methods).not.toContain("conversations.join");
    expect(await jobs.read(root().runKey, "cached-directory")).toEqual({
      runKey: "directory-snapshot",
    });
    expect((await repository.getDigestRun("digest-1"))?.status).toBe(
      "completed",
    );
  });

  it("uses a completed scan watermark for incremental history and preserves pagination bounds", async () => {
    const oldThrough = window.startMs;
    await repository.completeChannelSync("T1", "C1", oldThrough, true);
    await jobs.put(root().runKey, "channel:C1", { id: "C1" });
    const expectedOldest = (oldThrough - 48 * 3_600_000) / 1000;
    requestHandler = (method, body) => {
      expect(method).toBe("conversations.history");
      expect(Number(body.get("oldest"))).toBe(expectedOldest);
      return {
        ok: true,
        messages: [],
        response_metadata: { next_cursor: body.get("cursor") ? "" : "page-2" },
      };
    };
    const input: SlackJobParams = {
      ...root(),
      phase: { kind: "history", channelId: null, cursor: null },
    };
    const next = await executeSlackJobPhase(env, input);
    expect((await repository.getChannelSync("T1", "C1"))?.history_through).toBe(
      oldThrough,
    );
    // A concurrent newer digest must not change this job's remaining page bounds.
    await repository.completeChannelSync(
      "T1",
      "C1",
      window.endMs + 86_400_000,
      false,
    );
    await executeSlackJobPhase(env, { ...input, phase: next! });
    expect((await repository.getChannelSync("T1", "C1"))?.history_through).toBe(
      window.endMs + 86_400_000,
    );
    expect(
      (await repository.getChannelSync("T1", "C1"))?.full_scan_through,
    ).toBe(oldThrough);
  });

  it("keeps the chosen directory when a failed root job restarts after cache expiry", async () => {
    env.SLACK_BUDDY_JOB_PHASES = "10";
    await jobs.put("snapshot", "channel:C1", { id: "C1", is_member: true });
    await jobs.recordDirectory("T1", "snapshot");
    const fallback = requestHandler;
    requestHandler = (method, body) =>
      method === "conversations.history"
        ? { ok: false, error: "internal_error" }
        : fallback(method, body);
    await expect(runInstance(root())).rejects.toThrow("internal_error");
    vi.setSystemTime(now + 25 * 3_600_000);
    const calls: string[] = [];
    requestHandler = (method, body) => {
      calls.push(method);
      if (method === "conversations.history")
        expect(body.get("channel")).toBe("C1");
      return fallback(method, body);
    };
    checkpoints.clear(); // An explicit Workflow restart discards step checkpoints.
    await runInstance(root());
    expect(calls).toEqual(["conversations.history"]);
    expect(await jobs.read(root().runKey, "cached-directory")).toEqual({
      runKey: "snapshot",
    });
    expect(await jobs.freshDirectory("T1", now)).toEqual({
      runKey: "snapshot",
    });
  });

  it("does not rebuild or mutate a published directory when its job restarts", async () => {
    env.SLACK_BUDDY_JOB_PHASES = "10";
    const fallback = requestHandler;
    requestHandler = (method, body) => {
      if (method === "conversations.list")
        return { ok: true, channels: [{ id: "C1", is_member: true }] };
      if (method === "conversations.history")
        return { ok: false, error: "internal_error" };
      return fallback(method, body);
    };
    await expect(runInstance(root())).rejects.toThrow("internal_error");
    expect(await jobs.freshDirectory("T1", now)).toEqual({
      runKey: root().runKey,
    });
    vi.setSystemTime(now + 25 * 3_600_000);
    const calls: string[] = [];
    requestHandler = (method, body) => {
      calls.push(method);
      if (method === "conversations.list")
        return { ok: true, channels: [{ id: "C2", is_member: true }] };
      return fallback(method, body);
    };
    checkpoints.clear();
    await runInstance(root());
    expect(calls).toEqual(["conversations.history"]);
    expect(await jobs.all(root().runKey, "channel:")).toEqual([
      { id: "C1", is_member: true },
    ]);
    // A replay starting at the final membership phase must preserve it too.
    await executeSlackJobPhase(env, {
      ...root(),
      phase: {
        kind: "membership",
        channels: [{ id: "C2", is_member: true }],
        offset: 0,
        nextCursor: null,
      },
    });
    expect(await jobs.find(root().runKey, "channel:C2")).toBeNull();
    expect(await jobs.freshDirectory("T1", now + 1)).toBeNull();
  });

  it("performs a periodic full audit to find missed activity on old parents", async () => {
    await repository.completeChannelSync(
      "T1",
      "C1",
      window.endMs - 8 * 86_400_000,
      true,
    );
    await jobs.put(root().runKey, "channel:C1", { id: "C1" });
    const oldRoot = timestamp(now - 30 * 86_400_000);
    requestHandler = (method, body) => {
      expect(method).toBe("conversations.history");
      expect(body.has("oldest")).toBe(false);
      return {
        ok: true,
        messages: [
          {
            ts: oldRoot,
            text: "expired root",
            reply_count: 1,
            latest_reply: timestamp(window.startMs + 1000),
          },
        ],
      };
    };
    await executeSlackJobPhase(env, {
      ...root(),
      phase: { kind: "history", channelId: null, cursor: null },
    });
    expect(await jobs.read(root().runKey, `thread:C1:${oldRoot}`)).toEqual({
      channelId: "C1",
      threadTs: oldRoot,
    });
    expect(
      (await repository.getChannelSync("T1", "C1"))?.full_scan_through,
    ).toBe(window.endMs);
    expect(
      database.sqlite.prepare("SELECT * FROM slack_messages").all(),
    ).toHaveLength(0);
  });

  it("reconciles webhook replies to old parents during an incremental scan", async () => {
    const oldRoot = timestamp(now - 30 * 86_400_000);
    await repository.ingestMessage(
      message({ threadTs: oldRoot, text: "<@U1> please review" }),
    );
    await repository.completeChannelSync("T1", "C1", window.startMs, true);
    await jobs.put(root().runKey, "channel:C1", { id: "C1" });
    const called: string[] = [];
    requestHandler = (method, body) => {
      called.push(method);
      if (method === "conversations.history") {
        expect(body.has("oldest")).toBe(true);
        return { ok: true, messages: [] };
      }
      expect(method).toBe("conversations.replies");
      expect(body.get("ts")).toBe(oldRoot);
      return { ok: true, messages: [] };
    };
    const next = await executeSlackJobPhase(env, {
      ...root(),
      phase: { kind: "history", channelId: null, cursor: null },
    });
    await executeSlackJobPhase(env, { ...root(), phase: next! });
    expect(called).toEqual(["conversations.history", "conversations.replies"]);
  });

  it("keeps completed page checkpoints inside a larger job when a later page retries", async () => {
    env.SLACK_BUDDY_JOB_PHASES = "10";
    const calls: string[] = [];
    let failed = false;
    const fallback = requestHandler;
    requestHandler = (method, body) => {
      if (method !== "users.list") return fallback(method, body);
      const cursor = body.get("cursor") ?? "first";
      calls.push(cursor);
      if (cursor === "second" && !failed) {
        failed = true;
        return { ok: false, error: "internal_error" };
      }
      return {
        ok: true,
        members: [],
        response_metadata: { next_cursor: cursor === "first" ? "second" : "" },
      };
    };
    await runInstance({ ...root(), phase: { kind: "users", cursor: null } });
    expect(calls).toEqual(["first", "second", "second"]);
    const next = (await jobs.listIncomplete("T1"))[0];
    expect(next?.params.phase.kind).toBe("prepare");
  });

  it("retains an older directory snapshot while an active digest references it", async () => {
    const snapshot = await jobs.enqueue({
      ...root(),
      runKey: "old-directory",
      digest: null,
    });
    await jobs.put(snapshot.params.runKey, "channel:C1", { id: "C1" });
    await jobs.finish(snapshot.id, null);
    const active = await jobs.enqueue(root());
    await jobs.put(active.params.runKey, "cached-directory", {
      runKey: snapshot.params.runKey,
    });
    await jobs.recordDirectory("T1", "new-directory");
    await jobs.deleteExpiredCompletedRuns(now + 1);
    expect(await jobs.read(snapshot.params.runKey, "channel:C1")).toEqual({
      id: "C1",
    });
    await jobs.finish(active.id, null);
    await jobs.deleteExpiredCompletedRuns(now + 1);
    expect(await jobs.find(snapshot.params.runKey, "channel:C1")).toBeNull();
  });
  it("does not publish a partial snapshot from a directory chain started by older code", async () => {
    const input: SlackJobParams = {
      ...root(),
      digest: null,
      phase: {
        kind: "membership",
        channels: [{ id: "C1", is_member: true }],
        offset: 0,
        nextCursor: null,
      },
    };
    expect(await executeSlackJobPhase(env, input)).toBeNull();
    expect(await jobs.freshDirectory("T1", now - 86_400_000)).toBeNull();
  });

  it("skips revoked cached channels without recording successful scan coverage", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await jobs.put(root().runKey, "channel:C1", { id: "C1" });
    await jobs.put(root().runKey, "channel:C2", { id: "C2" });
    requestHandler = () => ({ ok: false, error: "not_in_channel" });
    const next = await executeSlackJobPhase(env, {
      ...root(),
      phase: { kind: "history", channelId: null, cursor: null },
    });
    expect(next).toEqual({ kind: "history", channelId: "C2", cursor: null });
    expect(await repository.getChannelSync("T1", "C1")).toBeNull();
    requestHandler = () => ({ ok: false, error: "missing_scope" });
    await expect(
      executeSlackJobPhase(env, { ...root(), phase: next! }),
    ).rejects.toThrow("missing_scope");
  });

  it("rejects configuration that exceeds the bounded Paid request budget", async () => {
    env.SLACK_BUDDY_JOB_PHASES = "21";
    await expect(runInstance(root())).rejects.toThrow("expected 1–20");
    expect(allRequests).toBe(0);
  });
});
