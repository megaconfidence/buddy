import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileDigestSchedule, safeWorkflowId } from "../src/scheduler";
import { getSlackIdentity } from "../src/slack/api";
import { SlackBuddyRepository } from "../src/storage/repository";
import { initialDigestJob, slackJobId } from "../src/domain/jobs";
import { SlackJobRepository } from "../src/storage/jobs";
import { digestWindowForDate } from "../src/domain/time";
import type { Env } from "../src/env";
import { testDatabase } from "./helpers/database";
import { message, now, window } from "./helpers/fixtures";

vi.mock("agents", () => ({ getAgentByName: vi.fn() }));

vi.mock("../src/slack/api", () => ({
  getSlackIdentity: vi.fn(),
}));

function instance(id: string, status: InstanceStatus["status"] = "queued") {
  return {
    id,
    status: vi.fn(async () => ({ status })),
    restart: vi.fn(async () => {}),
  };
}
let database: ReturnType<typeof testDatabase>;
let repository: SlackBuddyRepository;
let env: Env;
let instances: Map<string, ReturnType<typeof instance>>;
const latestId = "slack-buddy-2026-09-08-T1-U1";
const olderId = "slack-buddy-2026-09-07-T1-U1";
beforeEach(() => {
  database = testDatabase();
  repository = new SlackBuddyRepository(database.db);
  instances = new Map();
  env = {
    DB: database.db,
    SLACK_BOT_TOKEN: "test",
    SLACK_USER_ID: "U1",
    SLACK_BUDDY_DIGEST_HOUR: "8",
    SLACK_BUDDY_TIMEZONE: "Europe/Paris",
    SLACK_BUDDY_RETENTION_DAYS: "14",
    DIGEST_WORKFLOW: {
      createBatch: vi.fn(async (options: Array<{ id: string }>) =>
        options.map(({ id }) => {
          if (instances.has(id)) throw new Error("already_exists");
          const created = instance(id);
          instances.set(id, created);
          return created;
        }),
      ),
      get: vi.fn(async (id: string) => {
        const existing = instances.get(id);
        if (!existing) throw new Error("not_found");
        return existing;
      }),
    },
  } as unknown as Env;
  vi.mocked(getSlackIdentity).mockResolvedValue({
    teamId: "T1",
    botUserId: "UBOT",
  });
});
afterEach(() => {
  database.close();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function failedOlderRun() {
  await repository.createDigestRun({
    id: olderId,
    teamId: "T1",
    userId: "U1",
    window: digestWindowForDate("2026-09-07", "Europe/Paris"),
  });
  await repository.markDigestFailed(olderId, "temporary failure");
  const failed = instance(olderId, "errored");
  instances.set(olderId, failed);
  return failed;
}

describe("workflow IDs", () => {
  it("removes unsupported characters and respects Cloudflare's limit", () => {
    const id = safeWorkflowId(
      `slack-buddy:T123:U456:2026-09-04:${"long".repeat(30)}`,
    );
    expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u);
    expect(id.length).toBeLessThanOrEqual(100);
  });
});

describe("scheduled recovery and retention", () => {
  it("recovers older failed runs even before today's delivery time", async () => {
    const failed = await failedOlderRun();
    const result = await reconcileDigestSchedule(
      env,
      Date.parse("2026-09-09T04:00:00Z"),
    );
    expect(result.action).toBe("before_delivery_time");
    expect(failed.restart).not.toHaveBeenCalled();
    expect(instances.has(await slackJobId(olderId, 0))).toBe(true);
    expect((await repository.getDigestRun(olderId))?.status).toBe("running");
    expect(await repository.getDigestRun(latestId)).toBeNull();
  });

  it("recovers older runs when yesterday's briefing is already completed", async () => {
    const failed = await failedOlderRun();
    await repository.createDigestRun({
      id: latestId,
      teamId: "T1",
      userId: "U1",
      window,
    });
    await repository.recordDigestDelivery({
      digestId: latestId,
      channelId: "D1",
      messageTs: "1.000001",
    });
    expect((await reconcileDigestSchedule(env, now)).action).toBe("completed");
    expect(failed.restart).not.toHaveBeenCalled();
    expect(instances.has(await slackJobId(olderId, 0))).toBe(true);
  });

  it("continues creating today's run when an older bounded workflow cannot recover", async () => {
    await failedOlderRun();
    const id = await slackJobId(olderId, 0);
    const failed = instance(id, "errored");
    instances.set(id, failed);
    failed.restart.mockRejectedValue(new Error("restart unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reconcileDigestSchedule(env, now)).rejects.toThrow(
      "maintenance failed",
    );
    expect((await repository.getDigestRun(latestId))?.status).toBe("running");
  });

  it("checks the status even when createBatch returns an existing instance", async () => {
    await failedOlderRun();
    const id = await slackJobId(olderId, 0);
    const failed = instance(id, "errored");
    instances.set(id, failed);
    vi.mocked(env.DIGEST_WORKFLOW.createBatch).mockImplementation(
      async (options) =>
        options[0]?.id === id
          ? [failed as unknown as WorkflowInstance]
          : options.map(
              ({ id }) => instance(id!) as unknown as WorkflowInstance,
            ),
    );
    await reconcileDigestSchedule(env, Date.parse("2026-09-09T04:00:00Z"));
    expect(failed.restart).toHaveBeenCalledOnce();
  });

  it("cleans expired raw messages even when Slack authentication fails", async () => {
    await repository.ingestMessage(
      message({ postedAt: now - 15 * 86_400_000 }),
    );
    vi.mocked(getSlackIdentity).mockRejectedValue(new Error("invalid_auth"));
    await expect(reconcileDigestSchedule(env, now)).rejects.toThrow(
      "invalid_auth",
    );
    expect(
      database.sqlite.prepare("SELECT * FROM slack_messages").all(),
    ).toEqual([]);
  });

  it("starts one directory chain and makes no bulk Slack requests in cron", async () => {
    await reconcileDigestSchedule(env, now);
    await reconcileDigestSchedule(env, now + 3_600_000);
    expect(
      database.sqlite
        .prepare("SELECT * FROM slack_jobs WHERE kind = 'directory'")
        .all(),
    ).toHaveLength(1);
    expect(getSlackIdentity).toHaveBeenCalledTimes(2);
  });

  it("recovers the pending successor without rerunning its completed root", async () => {
    const jobs = new SlackJobRepository(env.DB);
    await repository.createDigestRun({
      id: latestId,
      teamId: "T1",
      userId: "U1",
      window,
    });
    const root = await jobs.enqueue(
      initialDigestJob({
        digestId: latestId,
        teamId: "T1",
        userId: "U1",
        window,
      }),
    );
    const next = await jobs.finish(root.id, {
      ...root.params,
      sequence: 1,
      phase: { kind: "users", cursor: "next" },
    });
    await reconcileDigestSchedule(env, now);
    expect(instances.has(root.id)).toBe(false);
    expect(instances.has(next!.id)).toBe(true);
  });
  it("waits for an active legacy instance before migrating its digest", async () => {
    const legacy = await failedOlderRun();
    legacy.status.mockResolvedValue({ status: "running" });
    await repository.attachWorkflow(olderId, olderId);
    await reconcileDigestSchedule(env, now);
    expect(instances.has(await slackJobId(olderId, 0))).toBe(false);
    expect(instances.has(await slackJobId(latestId, 0))).toBe(true);
    legacy.status.mockResolvedValue({ status: "errored" });
    await reconcileDigestSchedule(env, now);
    expect(instances.has(await slackJobId(olderId, 0))).toBe(true);
    expect(legacy.restart).not.toHaveBeenCalled();
  });

  it("queues new digests even with more than one sweep of existing failed runs", async () => {
    const jobs = new SlackJobRepository(env.DB);
    for (let index = 0; index < 30; index++) {
      const date = new Date(
        Date.parse("2026-07-01T00:00:00Z") + index * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      const id = `backlog-${index}`;
      const oldWindow = digestWindowForDate(date, "Europe/Paris");
      await repository.createDigestRun({
        id,
        teamId: "T1",
        userId: "U1",
        window: oldWindow,
      });
      const job = await jobs.enqueue(
        initialDigestJob({
          digestId: id,
          teamId: "T1",
          userId: "U1",
          window: oldWindow,
        }),
      );
      await jobs.markFailed(job.id, "service outage");
    }
    await reconcileDigestSchedule(env, now);
    expect(await jobs.get(await slackJobId(latestId, 0))).toBeDefined();
  });
  it("does not refresh a fresh directory on every hourly tick", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const jobs = new SlackJobRepository(env.DB);
    await jobs.recordDirectory("T1", "cached-snapshot");
    await reconcileDigestSchedule(env, now);
    await reconcileDigestSchedule(env, now + 3_600_000);
    expect(
      database.sqlite
        .prepare("SELECT * FROM slack_jobs WHERE kind = 'directory'")
        .all(),
    ).toHaveLength(0);
    await reconcileDigestSchedule(env, now + 25 * 3_600_000);
    expect(
      database.sqlite
        .prepare("SELECT * FROM slack_jobs WHERE kind = 'directory'")
        .all(),
    ).toHaveLength(1);
  });
});
