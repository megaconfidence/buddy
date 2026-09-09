import {
  addLocalDays,
  digestWindowForDate,
  localDateAt,
  targetDigestDate,
  retentionCutoffMs,
} from "./domain/time";
import type { DigestWorkflowParams } from "./domain/types";
import type { Env } from "./env";
import { ensurePublicChannelMembership, getSlackIdentity } from "./slack/api";
import { SlackBuddyRepository, type DigestRunRow } from "./storage/repository";

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
  const repository = new SlackBuddyRepository(env.DB);
  // Retention must run before any Slack request, even before delivery time or
  // while Slack/model credentials are unavailable.
  await repository.deleteExpiredData(
    retentionCutoffMs(env.SLACK_BUDDY_RETENTION_DAYS, nowMs),
  );
  const { teamId } = await getSlackIdentity(env.SLACK_BOT_TOKEN);
  const targetDate = targetDigestDate(
    nowMs,
    env.SLACK_BUDDY_TIMEZONE,
    Number(env.SLACK_BUDDY_DIGEST_HOUR),
  );
  const digestId = targetDate
    ? safeWorkflowId(`slack-buddy-${targetDate}-${teamId}-${env.SLACK_USER_ID}`)
    : null;
  if (targetDate && digestId) {
    await repository.createDigestRun({
      id: digestId,
      teamId,
      userId: env.SLACK_USER_ID,
      window: digestWindowForDate(targetDate, env.SLACK_BUDDY_TIMEZONE),
    });
  }

  let action:
    | "before_delivery_time"
    | "completed"
    | "created"
    | "running"
    | "restarted" = digestId ? "completed" : "before_delivery_time";
  const errors: unknown[] = [];
  for (const run of await repository.listIncompleteDigestRuns(
    teamId,
    env.SLACK_USER_ID,
  )) {
    try {
      const recovered = await reconcileDigestRun(env, repository, run);
      if (run.id === digestId) action = recovered;
    } catch (error) {
      errors.push(error);
      console.error("Slack Buddy could not reconcile a digest", {
        digestId: run.id,
        error: String(error),
      });
    }
  }
  // Channel discovery cannot prevent recovery of already-recorded runs.
  try {
    await ensurePublicChannelMembership(env, teamId);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Slack Buddy scheduled maintenance failed",
    );
  return { teamId, digestId, action };
}

async function reconcileDigestRun(
  env: Env,
  repository: SlackBuddyRepository,
  run: DigestRunRow,
): Promise<"completed" | "created" | "running" | "restarted"> {
  const params: DigestWorkflowParams = {
    digestId: run.id,
    teamId: run.team_id,
    userId: run.user_id,
    window: {
      localDate: run.local_date,
      timezone: run.timezone,
      startMs: run.window_start,
      endMs: run.window_end,
    },
  };
  let instance: WorkflowInstance | undefined;
  let created = false;
  try {
    [instance] = await env.DIGEST_WORKFLOW.createBatch([
      { id: run.id, params },
    ]);
    created = Boolean(instance);
  } catch (createError) {
    // Existing deterministic IDs throw on some runtimes. Preserve the create
    // error if lookup also fails (for example, a workflow service outage).
    try {
      instance = await env.DIGEST_WORKFLOW.get(run.id);
    } catch {
      throw createError;
    }
  }
  instance ??= await env.DIGEST_WORKFLOW.get(run.id);
  const status = await instance.status();
  if (
    status.status === "complete" &&
    run.slack_channel_id &&
    run.slack_message_ts
  ) {
    await repository.recordDigestDelivery({
      digestId: run.id,
      channelId: run.slack_channel_id,
      messageTs: run.slack_message_ts,
    });
    return "completed";
  }
  let action: "created" | "running" | "restarted" = created
    ? "created"
    : "running";
  if (["errored", "terminated", "complete"].includes(status.status)) {
    await instance.restart();
    action = "restarted";
  }
  await repository.attachWorkflow(run.id, instance.id);
  return action;
}

export function previousLocalDate(nowMs: number, timezone: string): string {
  return addLocalDays(localDateAt(nowMs, timezone), -1);
}

export function safeWorkflowId(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9-_]/gu, "-")
    .replace(/^[^a-zA-Z0-9_]+/u, "");
  return (sanitized || `slack-buddy-${crypto.randomUUID()}`).slice(0, 100);
}
