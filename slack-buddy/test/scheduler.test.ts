import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileDigestSchedule, safeWorkflowId } from "../src/scheduler";
import {
  getSlackIdentity,
  ensurePublicChannelMembership,
} from "../src/slack/api";
import { SlackBuddyRepository } from "../src/storage/repository";
import { digestWindowForDate } from "../src/domain/time";
import type { Env } from "../src/env";
import { testDatabase } from "./helpers/database";
import { message, now, window } from "./helpers/fixtures";

vi.mock("../src/slack/api", () => ({
  getSlackIdentity: vi.fn(),
  ensurePublicChannelMembership: vi.fn(),
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
  vi.mocked(ensurePublicChannelMembership).mockResolvedValue([]);
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
    expect(failed.restart).toHaveBeenCalledOnce();
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
    expect(failed.restart).toHaveBeenCalledOnce();
  });

  it("continues creating today's run when an older workflow cannot recover", async () => {
    const failed = await failedOlderRun();
    failed.restart.mockRejectedValue(new Error("restart unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reconcileDigestSchedule(env, now)).rejects.toThrow(
      "maintenance failed",
    );
    expect((await repository.getDigestRun(latestId))?.status).toBe("running");
  });

  it("checks the status even when createBatch returns an existing instance", async () => {
    const failed = await failedOlderRun();
    vi.mocked(env.DIGEST_WORKFLOW.createBatch).mockResolvedValue([
      failed as unknown as WorkflowInstance,
    ]);
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

  it("does not let channel discovery failures prevent workflow creation", async () => {
    vi.mocked(ensurePublicChannelMembership).mockRejectedValue(
      new Error("discovery failure"),
    );
    await expect(reconcileDigestSchedule(env, now)).rejects.toThrow(
      "maintenance failed",
    );
    expect((await repository.getDigestRun(latestId))?.status).toBe("running");
  });
});
