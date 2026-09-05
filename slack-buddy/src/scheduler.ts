import {
  addLocalDays,
  digestWindowForDate,
  localDateAt,
  targetDigestDate,
} from "./domain/time";
import type { DigestWorkflowParams } from "./domain/types";
import type { Env } from "./env";
import { ensurePublicChannelMembership, getSlackIdentity } from "./slack/api";
import { BuddyRepository } from "./storage/repository";

export async function reconcileDigestSchedule(
  env: Env,
  nowMs = Date.now(),
): Promise<{
  teamId: string;
  digestId: string | null;
  action:
    | "before_delivery_time"
    | "completed"
    | "created"
    | "running"
    | "restarted";
}> {
  const { teamId } = await getSlackIdentity(env.SLACK_BOT_TOKEN);
  await ensurePublicChannelMembership(env, teamId);
  const digestHour = Number(env.BUDDY_DIGEST_HOUR);
  const targetDate = targetDigestDate(nowMs, env.BUDDY_TIMEZONE, digestHour);
  if (!targetDate) {
    return {
      teamId,
      digestId: null,
      action: "before_delivery_time",
    };
  }

  const window = digestWindowForDate(targetDate, env.BUDDY_TIMEZONE);
  const digestId = safeWorkflowId(
    `buddy-${targetDate}-${teamId}-${env.SLACK_USER_ID}`,
  );
  const repository = new BuddyRepository(env.DB);
  await repository.createDigestRun({
    id: digestId,
    teamId,
    userId: env.SLACK_USER_ID,
    window,
  });

  const run = await repository.getDigestRun(digestId);
  if (run?.status === "completed") {
    return { teamId, digestId, action: "completed" };
  }

  const params: DigestWorkflowParams = {
    digestId,
    teamId,
    userId: env.SLACK_USER_ID,
    window,
  };

  let instance: WorkflowInstance | undefined;
  let action: "created" | "running" | "restarted";
  try {
    const created = await env.DIGEST_WORKFLOW.createBatch([
      {
        id: digestId,
        params,
      },
    ]);
    instance = created[0];
  } catch {
    // Older Workflow runtimes can throw for an existing deterministic ID.
  }

  if (instance) {
    action = "created";
  } else {
    instance = await env.DIGEST_WORKFLOW.get(digestId);
    const status = await instance.status();
    if (status.status === "errored" || status.status === "terminated") {
      await instance.restart();
      action = "restarted";
    } else {
      action = "running";
    }
  }

  await repository.attachWorkflow(digestId, instance.id);
  return { teamId, digestId, action };
}

export function previousLocalDate(nowMs: number, timezone: string): string {
  return addLocalDays(localDateAt(nowMs, timezone), -1);
}

export function safeWorkflowId(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9-_]/gu, "-")
    .replace(/^[^a-zA-Z0-9_]+/u, "");
  return (sanitized || `buddy-${crypto.randomUUID()}`).slice(0, 100);
}
