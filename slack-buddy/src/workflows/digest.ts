import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { BuddyAgent } from "../agent";
import { createBuddyModel, rankThreads, synthesizeDigest } from "../ai/model";
import { PROMPT_VERSION } from "../ai/prompts";
import {
  batchCandidateThreads,
  groupMessagesIntoThreads,
  scoreCandidateThreads,
} from "../domain/threads";
import type {
  DigestWorkflowParams,
  RankedDigestItem,
  RelevanceProfile,
} from "../domain/types";
import type { Env } from "../env";
import {
  deliverDigest,
  reconcileChannelHistory,
  syncSlackDirectory,
} from "../slack/api";
import { agentName } from "../slack/bot";
import { renderDigest } from "../slack/render";
import { BuddyRepository } from "../storage/repository";

const RETRY = {
  retries: {
    limit: 4,
    delay: "10 seconds" as const,
    backoff: "exponential" as const,
  },
  timeout: "10 minutes" as const,
};

export class DigestWorkflow extends WorkflowEntrypoint<
  Env,
  DigestWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<DigestWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ digestId: string; selectedItems: number }> {
    const input = event.payload;
    const repository = new BuddyRepository(this.env.DB);

    try {
      await step.do("mark digest running", RETRY, async () => {
        await repository.markDigestRunning(input.digestId);
        return { ok: true };
      });

      const profile = await step.do<RelevanceProfile>(
        "load relevance profile",
        RETRY,
        async () => {
          const agent = await getAgentByName<Env, BuddyAgent>(
            this.env.BUDDY_AGENT,
            agentName(input.teamId, input.userId),
          );
          await agent.configureForUser({
            teamId: input.teamId,
            userId: input.userId,
          });
          const profile = await agent.getRelevanceProfile();
          return {
            role: profile.role,
            mission: profile.mission,
            currentPriorities: [...profile.currentPriorities],
            watchTopics: [...profile.watchTopics],
            mustShowSignals: [...profile.mustShowSignals],
            suppressSignals: [...profile.suppressSignals],
            positiveExamples: [...profile.positiveExamples],
            negativeExamples: [...profile.negativeExamples],
            relevanceThreshold: profile.relevanceThreshold,
            borderlineThreshold: profile.borderlineThreshold,
            version: profile.version,
          };
        },
      );

      const channels = await step.do("sync Slack directory", RETRY, () =>
        syncSlackDirectory(this.env, input.teamId),
      );
      const reconcileStartMs = Math.min(
        input.window.startMs,
        input.window.endMs - Number(this.env.BUDDY_RECONCILE_HOURS) * 3_600_000,
      );

      for (const channel of channels) {
        await step.do(`reconcile ${channel.id}`, RETRY, () =>
          reconcileChannelHistory({
            env: this.env,
            teamId: input.teamId,
            channel,
            startMs: reconcileStartMs,
            endMs: input.window.endMs,
          }),
        );
      }

      const prepared = await step.do(
        "prepare candidate threads",
        RETRY,
        async () => {
          const messages = await repository.loadMessages(
            input.teamId,
            input.window.startMs,
            input.window.endMs,
          );
          const threads = groupMessagesIntoThreads(messages);
          return {
            inputMessageCount: messages.length,
            totalThreadCount: threads.length,
            batches: batchCandidateThreads(
              scoreCandidateThreads(threads, input.userId),
            ),
          };
        },
      );

      const rankedItems: RankedDigestItem[] = [];
      for (const [index, batch] of prepared.batches.entries()) {
        const items = await step.do(`rank batch ${index + 1}`, RETRY, () =>
          rankThreads(createBuddyModel(this.env), profile, batch),
        );
        rankedItems.push(...items);
      }

      const digest = await step.do("synthesize digest", RETRY, () =>
        synthesizeDigest(
          createBuddyModel(this.env),
          profile,
          rankedItems,
          prepared.totalThreadCount,
        ),
      );

      await step.do("save digest", RETRY, async () => {
        await repository.saveDigest({
          digestId: input.digestId,
          digest,
          markdown: renderDigest(digest, input.window, input.teamId),
          model: this.env.MISTRAL_MODEL,
          promptVersion: PROMPT_VERSION,
          inputMessageCount: prepared.inputMessageCount,
        });
        return { ok: true };
      });

      const existing = await step.do("load delivery state", RETRY, async () =>
        repository.getDigestRun(input.digestId),
      );

      const delivery = await step.do("deliver Slack digest", RETRY, () =>
        deliverDigest({
          env: this.env,
          digestId: input.digestId,
          teamId: input.teamId,
          window: input.window,
          digest,
          existingChannelId: existing?.slack_channel_id ?? null,
          existingMessageTs: existing?.slack_message_ts ?? null,
        }),
      );

      await step.do("mark digest complete", RETRY, async () => {
        await repository.recordDigestDelivery({
          digestId: input.digestId,
          channelId: delivery.channelId,
          messageTs: delivery.messageTs,
        });
        await repository.deleteExpiredData(
          Date.now() - Number(this.env.BUDDY_RETENTION_DAYS) * 86_400_000,
        );
        return { ok: true };
      });

      return {
        digestId: input.digestId,
        selectedItems: digest.items.length,
      };
    } catch (error) {
      await step.do("record digest failure", RETRY, async () => {
        await repository.markDigestFailed(input.digestId, errorMessage(error));
        return { ok: true };
      });
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
