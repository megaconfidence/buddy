import {
  addLocalDays,
  digestWindowForDate,
  localDateAt,
  targetDigestDate,
  retentionCutoffMs,
} from "./domain/time";
import { syncSettings } from "./domain/sync";
import { initialDigestJob } from "./domain/jobs";
import type { Env } from "./env";
import { getSlackIdentity } from "./slack/api";
import { SlackBuddyRepository } from "./storage/repository";
import { SlackJobRepository } from "./storage/jobs";
import { launchSlackJob } from "./workflows/jobs";

export async function reconcileDigestSchedule(env: Env, nowMs = Date.now()) {
  const repository = new SlackBuddyRepository(env.DB);
  const jobs = new SlackJobRepository(env.DB);
  // Cleanup must run even if Slack authentication or job recovery fails.
  await repository.deleteExpiredData(
    retentionCutoffMs(env.SLACK_BUDDY_RETENTION_DAYS, nowMs),
  );
  await jobs.deleteExpiredCompletedRuns(
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
  if (targetDate && digestId)
    await repository.createDigestRun({
      id: digestId,
      teamId,
      userId: env.SLACK_USER_ID,
      window: digestWindowForDate(targetDate, env.SLACK_BUDDY_TIMEZONE),
    });
  const errors: unknown[] = [];
  for (const run of await repository.listIncompleteDigestRuns(
    teamId,
    env.SLACK_USER_ID,
    true,
  )) {
    try {
      // A deployment does not interrupt old instances. Let an active legacy
      // instance finish before migrating it to avoid concurrent delivery.
      if (
        run.status === "running" &&
        run.workflow_instance_id &&
        !run.workflow_instance_id.startsWith("slack-buddy-free-v1-")
      ) {
        const legacy = await env.DIGEST_WORKFLOW.get(run.workflow_instance_id);
        const status = await legacy.status();
        if (!["errored", "terminated", "complete"].includes(status.status))
          continue;
        if ((await repository.getDigestRun(run.id))?.status === "completed")
          continue;
      }
      // New IDs run the bounded implementation, including recovery of failed
      // monolithic instances pinned to a previous deployment.
      await jobs.enqueue(
        initialDigestJob({
          digestId: run.id,
          teamId: run.team_id,
          userId: run.user_id,
          window: {
            localDate: run.local_date,
            timezone: run.timezone,
            startMs: run.window_start,
            endMs: run.window_end,
          },
        }),
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (
    !(await jobs.freshDirectory(
      teamId,
      nowMs - syncSettings(env).directoryTtlMs,
    ))
  )
    await jobs.enqueueDirectory({
      protocol: "free-v1",
      runKey: `directory:${teamId}:${Math.floor(nowMs / 3_600_000)}`,
      teamId,
      userId: env.SLACK_USER_ID,
      digest: null,
      sequence: 0,
      phase: { kind: "start" },
    });
  let action: string = digestId ? "completed" : "before_delivery_time";
  if (
    digestId &&
    (await repository.getDigestRun(digestId))?.status !== "completed"
  )
    action = "running";
  // Bounded recovery sweep; no directory pagination or joins in the cron invocation.
  for (const job of await jobs.listIncomplete(teamId)) {
    try {
      const recovered = await launchSlackJob(env, job, true);
      if (job.params.digest?.digestId === digestId) action = recovered;
    } catch (error) {
      errors.push(error);
      console.error("Slack Buddy could not recover a job", {
        jobId: job.id,
        error: String(error),
      });
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Slack Buddy scheduled maintenance failed",
    );
  return { teamId, digestId, action };
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
