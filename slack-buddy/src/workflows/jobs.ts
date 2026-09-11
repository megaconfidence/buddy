import type { WorkflowStep } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { SlackBuddyAgent } from "../agent";
import {
  createSlackBuddyModel,
  rankThreads,
  synthesizeDigest,
} from "../ai/model";
import { syncSettings } from "../domain/sync";
import { retentionCutoffMs } from "../domain/time";
import { PROMPT_VERSION } from "../ai/prompts";
import {
  slackJobId,
  type SlackJobParams,
  type SlackJobPhase,
} from "../domain/jobs";
import {
  batchCandidateThreads,
  groupMessagesIntoThreads,
  scoreCandidateThreads,
} from "../domain/threads";
import type { RankedDigestItem, RelevanceProfile } from "../domain/types";
import type { Env } from "../env";
import {
  deliverDigestPage,
  ensureChannelMembershipBatch,
  listChannelsPage,
  listUsersPage,
  MEMBERSHIP_BATCH_SIZE,
  reconcileHistoryPage,
  reconcileRepliesPage,
  type SlackChannel,
  type ThreadTarget,
} from "../slack/api";
import { renderDigest } from "../slack/render";
import { SlackJobRepository, type SlackJob } from "../storage/jobs";
import { SlackBuddyRepository } from "../storage/repository";

// Each phase is bounded; syncSettings also caps phases per Paid instance.
// Retried steps keep their phase checkpoint and do not repeat prior pages.
export const JOB_RETRY = {
  retries: {
    limit: 1,
    delay: "10 seconds" as const,
    backoff: "exponential" as const,
  },
  timeout: "10 minutes" as const,
};
// Delivery failures wait for scheduled recovery. Retrying a write immediately
// can turn a persistent Slack failure into an endless chain of new instances.
const DELIVERY_RETRY = {
  ...JOB_RETRY,
  retries: { ...JOB_RETRY.retries, limit: 0 },
};
const LEDGER_RETRY = {
  retries: { limit: 3, delay: "5 seconds" as const },
  timeout: "1 minute" as const,
};

/** Idempotent instance creation; also recovers an interrupted bounded job. */
export async function launchSlackJob(
  env: Env,
  job: SlackJob,
  recover = false,
): Promise<"created" | "running" | "restarted"> {
  const jobs = new SlackJobRepository(env.DB);
  if ((await jobs.get(job.id)).status === "completed") return "running";
  // Rotate attempted jobs to the back of the recovery sweep, even on outage.
  if (recover) await jobs.touch(job.id);
  let instance: WorkflowInstance | undefined;
  let created = false;
  try {
    [instance] = await env.DIGEST_WORKFLOW.createBatch([
      { id: job.id, params: job.params },
    ]);
    created = Boolean(instance);
  } catch (error) {
    try {
      instance = await env.DIGEST_WORKFLOW.get(job.id);
    } catch {
      throw error;
    }
  }
  instance ??= await env.DIGEST_WORKFLOW.get(job.id);
  const status = await instance.status();
  let action: "created" | "running" | "restarted" = created
    ? "created"
    : "running";
  // Recheck the ledger: a fast child can complete during the status request.
  if (
    recover &&
    ["errored", "terminated", "complete"].includes(status.status) &&
    (await jobs.get(job.id)).status !== "completed"
  ) {
    await instance.restart();
    action = "restarted";
  }
  if (
    job.params.digest &&
    (action === "restarted" ||
      !["errored", "terminated"].includes(status.status))
  )
    await new SlackBuddyRepository(env.DB).attachWorkflow(
      job.params.digest.digestId,
      instance.id,
    );
  return action;
}

export async function runSlackJob(
  env: Env,
  input: SlackJobParams,
  instanceId: string,
  step: WorkflowStep,
) {
  if (
    input.protocol !== "free-v1" ||
    instanceId !== (await slackJobId(input.runKey, input.sequence))
  ) {
    throw new Error("Invalid bounded Slack job identity");
  }
  const jobs = new SlackJobRepository(env.DB);
  const repository = new SlackBuddyRepository(env.DB);
  // Read the ledger outside checkpoints so restarted completed parents stay done.
  const job = await jobs.enqueue(input);
  if (job.status === "completed") return { jobId: job.id };
  try {
    await step.do("mark job running", LEDGER_RETRY, async () => {
      await jobs.markRunning(job.id);
      if (job.params.digest)
        await repository.markDigestRunning(job.params.digest.digestId);
      return true;
    });
    let phase: SlackJobPhase | null = job.params.phase;
    const limit = syncSettings(env).phasesPerJob;
    for (let index = 0; index < limit && phase; index++) {
      const current: SlackJobPhase = phase;
      phase = await step.do<SlackJobPhase | null>(
        index === 0 ? "execute bounded phase" : `execute phase ${index + 1}`,
        current.kind === "deliver" ? DELIVERY_RETRY : JOB_RETRY,
        () => executeSlackJobPhase(env, { ...job.params, phase: current }),
      );
      // Keep model work and delivery isolated. Delivery intent keys are per job.
      if (
        !phase ||
        ![
          "start",
          "users",
          "channels",
          "membership",
          "history",
          "replies",
        ].includes(current.kind) ||
        !["users", "channels", "membership", "history", "replies"].includes(
          phase.kind,
        )
      )
        break;
    }
    const next = phase
      ? { ...job.params, sequence: job.params.sequence + 1, phase }
      : null;
    await step.do("commit successor", LEDGER_RETRY, async () => {
      await jobs.finish(job.id, next);
      return true;
    });
    if (next) {
      // Failure here leaves the successor pending; the hourly scheduler resumes it.
      await step.do("launch successor", LEDGER_RETRY, async () => {
        await launchSlackJob(
          env,
          await jobs.get(await slackJobId(next.runKey, next.sequence)),
        );
        return true;
      });
    }
    return { jobId: job.id };
  } catch (error) {
    await step.do("record job failure", LEDGER_RETRY, async () => {
      if ((await jobs.get(job.id)).status !== "completed") {
        await jobs.markFailed(job.id, String(error));
        if (job.params.digest)
          await repository.markDigestFailed(
            job.params.digest.digestId,
            String(error),
          );
      }
      return true;
    });
    throw error;
  }
}

type Prepared = {
  inputMessageCount: number;
  totalThreadCount: number;
  batchCount: number;
};
type Delivery = { channelId: string; messageTs: string };

/** A phase performs only bounded external work and returns cursor metadata. */
export async function executeSlackJobPhase(
  env: Env,
  input: SlackJobParams,
): Promise<SlackJobPhase | null> {
  const jobs = new SlackJobRepository(env.DB);
  const repository = new SlackBuddyRepository(env.DB);
  const { phase, runKey, teamId, digest } = input;
  const settings = syncSettings(env);
  if (
    ["users", "channels", "membership"].includes(phase.kind) &&
    (await jobs.find(runKey, "directory-complete"))
  )
    return digest ? { kind: "history", channelId: null, cursor: null } : null;
  if (phase.kind === "start") {
    if (digest) {
      const agent = await getAgentByName<Env, SlackBuddyAgent>(
        env.SLACK_BUDDY_AGENT,
        `${teamId}:${input.userId}`,
      );
      const profile = await agent.configureForUser({
        teamId,
        userId: input.userId,
      });
      await jobs.put(runKey, "profile", JSON.parse(JSON.stringify(profile)));
    }
    // Workflow restarts discard checkpoints. Keep the original directory
    // choice, even after its TTL expires or another run publishes a new one.
    if (
      (await jobs.find(runKey, "cached-directory")) ||
      (await jobs.find(runKey, "directory-complete"))
    )
      return digest ? { kind: "history", channelId: null, cursor: null } : null;
    if (await jobs.find(runKey, "directory-build"))
      return { kind: "users", cursor: null };
    const cached = await jobs.freshDirectory(
      teamId,
      Date.now() - settings.directoryTtlMs,
    );
    if (cached) {
      if (!digest) return null;
      await jobs.put(runKey, "cached-directory", cached);
      return { kind: "history", channelId: null, cursor: null };
    }
    // Older directory-only jobs did not persist every channel page. Only a
    // refresh started by this implementation may publish a reusable snapshot.
    await jobs.put(runKey, "directory-build", true);
    return { kind: "users", cursor: null };
  }
  if (phase.kind === "users") {
    const page = await listUsersPage(env.SLACK_BOT_TOKEN, phase.cursor);
    await repository.upsertUsers(
      page.users.map((user) => ({
        teamId,
        userId: user.id,
        displayName: user.profile?.display_name || user.name || null,
        realName: user.profile?.real_name || user.real_name || null,
        isBot: user.is_bot ?? false,
      })),
    );
    return page.nextCursor
      ? { kind: "users", cursor: page.nextCursor }
      : { kind: "channels", cursor: null };
  }
  if (phase.kind === "channels") {
    const page = await listChannelsPage(env.SLACK_BOT_TOKEN, phase.cursor);
    if (page.channels.length === 0) {
      return page.nextCursor
        ? { kind: "channels", cursor: page.nextCursor }
        : finishDirectory();
    }
    return {
      kind: "membership",
      channels: page.channels,
      offset: 0,
      nextCursor: page.nextCursor,
    };
  }
  if (phase.kind === "membership") {
    const channels = await ensureChannelMembershipBatch(
      env,
      teamId,
      phase.channels.slice(phase.offset, phase.offset + MEMBERSHIP_BATCH_SIZE),
    );
    await jobs.putMany(
      runKey,
      channels.map((channel) => ({
        name: `channel:${channel.id}`,
        value: channel,
      })),
    );
    const offset = phase.offset + MEMBERSHIP_BATCH_SIZE;
    if (offset < phase.channels.length) return { ...phase, offset };
    if (phase.nextCursor) return { kind: "channels", cursor: phase.nextCursor };
    return finishDirectory();
  }
  async function finishDirectory(): Promise<SlackJobPhase | null> {
    if (await jobs.find(runKey, "directory-build"))
      await jobs.recordDirectory(teamId, runKey);
    return digest ? { kind: "history", channelId: null, cursor: null } : null;
  }
  if (!digest) throw new Error("Digest phase requires a digest run");
  if ((await repository.getDigestRun(digest.digestId))?.status === "completed")
    return null;
  if (phase.kind === "history") {
    const snapshot =
      (await jobs.find<{ runKey: string }>(runKey, "cached-directory"))
        ?.runKey ?? runKey;
    const channel = phase.channelId
      ? { id: phase.channelId }
      : (await jobs.next<SlackChannel>(snapshot, "channel:"))?.value;
    if (!channel) return seedReplyTargets();
    // Persist bounds once, so concurrent digests and page retries cannot move
    // the scan window. A legacy cursor must finish its original full scan.
    const rangeKey = `history-range:${channel.id}`;
    let range = await jobs.find<{ oldestMs: number | null }>(runKey, rangeKey);
    if (!range) {
      const state = await repository.getChannelSync(teamId, channel.id);
      const full =
        phase.cursor !== null ||
        !state?.full_scan_through ||
        state.full_scan_through <=
          digest.window.endMs - settings.fullScanIntervalMs;
      range = {
        oldestMs: full
          ? null
          : Math.max(
              retentionCutoffMs(env.SLACK_BUDDY_RETENTION_DAYS),
              Math.min(
                digest.window.startMs,
                state.history_through - settings.lookbackMs,
              ),
            ),
      };
      await jobs.put(runKey, rangeKey, range);
    }
    const page = await reconcileHistoryPage({
      env,
      teamId,
      channelId: channel.id,
      cursor: phase.cursor,
      oldestMs: range.oldestMs,
      startMs: Math.min(
        digest.window.startMs,
        digest.window.endMs -
          (range.oldestMs === null
            ? Math.max(settings.lookbackMs, settings.fullScanIntervalMs)
            : settings.lookbackMs),
      ),
      endMs: digest.window.endMs,
    });
    await jobs.putMany(
      runKey,
      page.threads.map((thread) => ({
        name: `thread:${thread.channelId}:${thread.threadTs}`,
        value: thread,
      })),
    );
    if (page.nextCursor)
      return {
        kind: "history",
        channelId: channel.id,
        cursor: page.nextCursor,
      };
    if (!page.unavailable)
      await repository.completeChannelSync(
        teamId,
        channel.id,
        digest.window.endMs,
        range.oldestMs === null,
      );
    const next = await jobs.next<SlackChannel>(
      snapshot,
      "channel:",
      `channel:${channel.id}`,
    );
    return next
      ? { kind: "history", channelId: next.value.id, cursor: null }
      : seedReplyTargets();
  }
  async function seedReplyTargets(): Promise<SlackJobPhase> {
    if (!digest) throw new Error("Missing digest window");
    // Webhook replies can refer to parents older than the incremental window.
    const targets = await repository.activeReplyTargets(
      teamId,
      digest.window.startMs,
      digest.window.endMs,
    );
    await jobs.putMany(
      runKey,
      targets.map((thread) => ({
        name: `thread:${thread.channelId}:${thread.threadTs}`,
        value: thread,
      })),
    );
    return { kind: "replies", threadKey: null, cursor: null };
  }
  if (phase.kind === "replies") {
    const thread = phase.threadKey
      ? {
          name: phase.threadKey,
          value: await jobs.read<ThreadTarget>(runKey, phase.threadKey),
        }
      : await jobs.next<ThreadTarget>(runKey, "thread:");
    if (!thread) return { kind: "prepare" };
    const page = await reconcileRepliesPage({
      env,
      teamId,
      ...thread.value,
      endMs: digest.window.endMs,
      cursor: phase.cursor,
    });
    if (page.nextCursor)
      return {
        kind: "replies",
        threadKey: thread.name,
        cursor: page.nextCursor,
      };
    const next = await jobs.next<ThreadTarget>(runKey, "thread:", thread.name);
    return next
      ? { kind: "replies", threadKey: next.name, cursor: null }
      : { kind: "prepare" };
  }
  if (phase.kind === "prepare") {
    const messages = await repository.loadMessages(
      teamId,
      digest.window.startMs,
      digest.window.endMs,
    );
    const threads = groupMessagesIntoThreads(messages);
    const batches = batchCandidateThreads(
      scoreCandidateThreads(threads, input.userId, digest.window),
    );
    await jobs.putMany(
      runKey,
      batches.map((batch, index) => ({
        name: `batch:${index}`,
        value: batch.map((candidate) => candidate.thread.id),
      })),
    );
    await jobs.put(runKey, "prepared", {
      inputMessageCount: messages.filter(
        (message) => message.postedAt >= digest.window.startMs,
      ).length,
      totalThreadCount: threads.length,
      batchCount: batches.length,
    } satisfies Prepared);
    return batches.length ? { kind: "rank", batch: 0 } : { kind: "synthesize" };
  }
  if (phase.kind === "rank") {
    const ids = new Set(
      await jobs.read<string[]>(runKey, `batch:${phase.batch}`),
    );
    const messages = await repository.loadMessages(
      teamId,
      digest.window.startMs,
      digest.window.endMs,
      [...ids],
    );
    const candidates = scoreCandidateThreads(
      groupMessagesIntoThreads(messages).filter((thread) => ids.has(thread.id)),
      input.userId,
      digest.window,
    );
    const profile = await jobs.read<RelevanceProfile>(runKey, "profile");
    const items = await rankThreads(
      createSlackBuddyModel(env),
      profile,
      candidates,
    );
    await jobs.put(runKey, `rank:${phase.batch}`, items);
    const prepared = await jobs.read<Prepared>(runKey, "prepared");
    return phase.batch + 1 < prepared.batchCount
      ? { kind: "rank", batch: phase.batch + 1 }
      : { kind: "synthesize" };
  }
  if (phase.kind === "synthesize") {
    const profile = await jobs.read<RelevanceProfile>(runKey, "profile");
    const prepared = await jobs.read<Prepared>(runKey, "prepared");
    const ranked = (await jobs.all<RankedDigestItem[]>(runKey, "rank:")).flat();
    const structured = await synthesizeDigest(
      createSlackBuddyModel(env),
      profile,
      ranked,
      prepared.totalThreadCount,
    );
    await repository.saveDigest({
      digestId: digest.digestId,
      digest: structured,
      markdown: renderDigest(structured, digest.window, teamId),
      model: env.MISTRAL_MODEL,
      promptVersion: PROMPT_VERSION,
      inputMessageCount: prepared.inputMessageCount,
    });
    return { kind: "deliver", page: 0, channelId: null, cursor: null };
  }
  const stored = await repository.getStoredDigest(digest.digestId);
  if (!stored) throw new Error("Missing synthesized digest");
  const pageKey = `delivered:${phase.page}`;
  let delivery = await jobs.find<Delivery>(runKey, pageKey);
  if (!delivery) {
    // A write may have succeeded before a crash. Start a NEW search from the
    // head, never retry posting against a cursor that predates that write.
    if (await jobs.find(runKey, `write-intent:${input.sequence}`)) {
      return { ...phase, channelId: null, cursor: null };
    }
    const existing = await repository.getDigestRun(digest.digestId);
    const result = await deliverDigestPage({
      env,
      digestId: digest.digestId,
      teamId,
      window: digest.window,
      digest: stored.structured,
      page: phase.page,
      channelId: phase.channelId ?? existing?.slack_channel_id ?? null,
      cursor: phase.cursor,
      existingMessageTs:
        phase.page === 0 ? (existing?.slack_message_ts ?? null) : null,
      beforeWrite: () =>
        jobs.put(runKey, `write-intent:${input.sequence}`, true),
    });
    if (!result.messageTs)
      return {
        ...phase,
        channelId: result.channelId,
        cursor: result.nextCursor,
      };
    delivery = { channelId: result.channelId, messageTs: result.messageTs };
    await jobs.put(runKey, pageKey, delivery);
  }
  if ((phase.page + 1) * 15 < stored.structured.items.length)
    return {
      kind: "deliver",
      page: phase.page + 1,
      channelId: delivery.channelId,
      cursor: null,
    };
  const first = await jobs.read<Delivery>(runKey, "delivered:0");
  await repository.recordDigestDelivery({
    digestId: digest.digestId,
    ...first,
  });
  return null;
}
