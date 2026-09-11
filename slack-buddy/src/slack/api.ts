import { SlackApiError, type SlackApiResponse } from "@chat-adapter/slack/api";
import { callSlackApi, postSlackMessage, updateSlackMessage } from "./client";
import type {
  DigestWindow,
  SlackMessage,
  StructuredDigest,
} from "../domain/types";
import type { Env } from "../env";
import { retentionCutoffMs } from "../domain/time";
import { SlackBuddyRepository } from "../storage/repository";
import {
  digestMarkerBlockId,
  renderDigest,
  renderDigestBlocks,
} from "./render";

export type SlackChannel = {
  id: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
};

export type SlackUser = {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
};

export type SlackHistoryMessage = {
  blocks?: Array<{ block_id?: string }>;
  bot_id?: string;
  edited?: { ts?: string };
  reply_count?: number;
  latest_reply?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
};

export async function getSlackIdentity(
  token: string,
): Promise<{ teamId: string; botUserId: string }> {
  const result = await callSlackApi<
    SlackApiResponse & { team_id?: string; user_id?: string }
  >("auth.test", {}, { token });
  if (!result.team_id || !result.user_id) {
    throw new Error("Slack auth.test did not return team_id and user_id");
  }
  return { teamId: result.team_id, botUserId: result.user_id };
}

/** One API page per checkpointed sync phase. Never paginate here. */
export async function listUsersPage(token: string, cursor: string | null) {
  const result = await callSlackApi<
    SlackApiResponse & {
      members?: SlackUser[];
      response_metadata?: { next_cursor?: string };
    }
  >("users.list", { cursor: cursor ?? undefined, limit: 200 }, { token });
  return {
    users: result.members ?? [],
    nextCursor: result.response_metadata?.next_cursor || null,
  };
}

export async function listChannelsPage(token: string, cursor: string | null) {
  const result = await callSlackApi<
    SlackApiResponse & {
      channels?: SlackChannel[];
      response_metadata?: { next_cursor?: string };
    }
  >(
    "conversations.list",
    {
      cursor: cursor ?? undefined,
      limit: 200,
      exclude_archived: true,
      types: "public_channel,private_channel",
    },
    { token },
  );
  // Keep Workflow payloads limited to metadata actually used by the pipeline.
  return {
    channels: (result.channels ?? []).map(
      ({ id, name, is_private, is_archived, is_member }) => ({
        id,
        name,
        is_private,
        is_archived,
        is_member,
      }),
    ),
    nextCursor: result.response_metadata?.next_cursor || null,
  };
}

export const MEMBERSHIP_BATCH_SIZE = 50;
export async function ensureChannelMembershipBatch(
  env: Env,
  teamId: string,
  channels: SlackChannel[],
) {
  if (channels.length > MEMBERSHIP_BATCH_SIZE)
    throw new Error("Slack membership batch exceeds request budget");
  const accessible: SlackChannel[] = [];
  for (const source of channels) {
    const channel = { ...source };
    if (channel.is_archived) continue;
    if (
      !channel.is_private &&
      !channel.is_member &&
      env.SLACK_BUDDY_AUTO_JOIN_PUBLIC_CHANNELS === "true"
    ) {
      try {
        await callSlackApi(
          "conversations.join",
          { channel: channel.id },
          { token: env.SLACK_BOT_TOKEN },
        );
        channel.is_member = true;
      } catch (error) {
        // Only permanent membership restrictions can be skipped. Infrastructure,
        // auth and rate-limit failures must remain recoverable jobs.
        if (
          !(error instanceof SlackApiError) ||
          ![
            "restricted_action",
            "restricted_action_read_only_channel",
            "method_not_supported_for_channel_type",
            "channel_not_found",
            "is_archived",
            "no_permission",
          ].includes(error.response?.error ?? "")
        )
          throw error;
        console.warn("Slack Buddy could not join a public Slack channel", {
          channelId: channel.id,
          error: String(error),
        });
      }
    }
    if (channel.is_member) accessible.push(channel);
  }
  await new SlackBuddyRepository(env.DB).upsertChannels(
    accessible.map((channel) => ({
      teamId,
      channelId: channel.id,
      name: channel.name ?? null,
      isPrivate: channel.is_private ?? false,
      isArchived: channel.is_archived ?? false,
    })),
  );
  return accessible;
}

function unavailableConversation(error: unknown) {
  if (
    error instanceof SlackApiError &&
    [
      "not_in_channel",
      "channel_not_found",
      "thread_not_found",
      "message_not_found",
    ].includes(error.response?.error ?? "")
  ) {
    console.warn("Slack Buddy skipped unavailable conversation history", {
      error: String(error),
    });
    return {
      ok: true,
      messages: [] as SlackHistoryMessage[],
      response_metadata: undefined,
      unavailable: true,
    };
  }
  throw error;
}

export type ThreadTarget = { channelId: string; threadTs: string };
export async function reconcileHistoryPage(input: {
  env: Env;
  teamId: string;
  channelId: string;
  startMs: number;
  endMs: number;
  oldestMs?: number | null;
  cursor: string | null;
}) {
  const result = await callSlackApi<
    SlackApiResponse & {
      messages?: SlackHistoryMessage[];
      response_metadata?: { next_cursor?: string };
    }
  >(
    "conversations.history",
    {
      channel: input.channelId,
      cursor: input.cursor ?? undefined,
      inclusive: true,
      latest: (input.endMs / 1000).toFixed(6),
      limit: 200,
      oldest:
        input.oldestMs == null ? undefined : (input.oldestMs / 1000).toFixed(6),
      // Full audits omit oldest to discover missed replies on old parents.
    },
    { token: input.env.SLACK_BOT_TOKEN },
  ).catch(unavailableConversation);
  await ingestRetainedPage(input, result.messages ?? []);
  return {
    unavailable: "unavailable" in result && result.unavailable,
    threads: (result.messages ?? []).flatMap((message) =>
      message.ts &&
      (message.reply_count ?? 0) > 0 &&
      message.latest_reply &&
      slackTimestampMs(message.latest_reply) >= input.startMs
        ? [{ channelId: input.channelId, threadTs: message.ts }]
        : [],
    ),
    nextCursor: result.response_metadata?.next_cursor || null,
  };
}

export async function reconcileRepliesPage(input: {
  env: Env;
  teamId: string;
  channelId: string;
  threadTs: string;
  endMs: number;
  cursor: string | null;
}) {
  const result = await callSlackApi<
    SlackApiResponse & {
      messages?: SlackHistoryMessage[];
      response_metadata?: { next_cursor?: string };
    }
  >(
    "conversations.replies",
    {
      channel: input.channelId,
      ts: input.threadTs,
      cursor: input.cursor ?? undefined,
      oldest: (
        retentionCutoffMs(input.env.SLACK_BUDDY_RETENTION_DAYS) / 1000
      ).toFixed(6),
      latest: (input.endMs / 1000).toFixed(6),
      inclusive: true,
      limit: 200,
    },
    { token: input.env.SLACK_BOT_TOKEN },
  ).catch(unavailableConversation);
  await ingestRetainedPage(input, result.messages ?? []);
  return { nextCursor: result.response_metadata?.next_cursor || null };
}

async function ingestRetainedPage(
  input: { env: Env; teamId: string; channelId: string; endMs: number },
  messages: SlackHistoryMessage[],
) {
  const cutoff = retentionCutoffMs(input.env.SLACK_BUDDY_RETENTION_DAYS);
  const records = messages
    .filter(
      (message) =>
        message.ts &&
        slackTimestampMs(message.ts) >= cutoff &&
        slackTimestampMs(message.ts) < input.endMs,
    )
    .map((message) =>
      historyMessageToRecord(input.teamId, input.channelId, message),
    );
  const repository = new SlackBuddyRepository(input.env.DB);
  await repository.ingestMessages(records);
  const latestTs = records
    .map((record) => record.messageTs)
    .sort()
    .at(-1);
  if (latestTs)
    await repository.updateChannelCursor({
      teamId: input.teamId,
      channelId: input.channelId,
      latestTs,
    });
}

/** Inspect at most one history page, then send at most one digest page. */
export async function deliverDigestPage(input: {
  env: Env;
  digestId: string;
  teamId: string;
  window: DigestWindow;
  digest: StructuredDigest;
  page: number;
  channelId: string | null;
  cursor: string | null;
  existingMessageTs: string | null;
  beforeWrite: () => Promise<void>;
}): Promise<{
  channelId: string;
  messageTs: string | null;
  nextCursor: string | null;
}> {
  let channelId = input.channelId;
  if (!channelId) {
    const dm = await callSlackApi<
      SlackApiResponse & { channel?: { id?: string } }
    >(
      "conversations.open",
      { users: input.env.SLACK_USER_ID },
      { token: input.env.SLACK_BOT_TOKEN },
    );
    channelId = dm.channel?.id ?? null;
  }
  if (!channelId)
    throw new Error("Slack conversations.open did not return a DM channel");
  const markerId =
    input.page === 0
      ? input.digestId
      : `${input.digestId}:part:${input.page + 1}`;
  let messageTs = input.existingMessageTs;
  if (!messageTs) {
    const result = await callSlackApi<
      SlackApiResponse & {
        messages?: SlackHistoryMessage[];
        response_metadata?: { next_cursor?: string };
      }
    >(
      "conversations.history",
      {
        channel: channelId,
        cursor: input.cursor ?? undefined,
        limit: 100,
        oldest: (input.window.startMs / 1000).toFixed(6),
      },
      { token: input.env.SLACK_BOT_TOKEN },
    );
    messageTs =
      result.messages?.find(
        (message) =>
          message.ts &&
          message.blocks?.some(
            (block) => block.block_id === digestMarkerBlockId(markerId),
          ),
      )?.ts ?? null;
    const nextCursor = result.response_metadata?.next_cursor || null;
    if (!messageTs && nextCursor)
      return { channelId, messageTs: null, nextCursor };
  }
  const pageCount = Math.max(1, Math.ceil(input.digest.items.length / 15));
  const digest: StructuredDigest = {
    ...input.digest,
    overview:
      pageCount > 1
        ? `Part ${input.page + 1}/${pageCount}. ${input.digest.overview}`
        : input.digest.overview,
    items: input.digest.items.slice(input.page * 15, (input.page + 1) * 15),
    omittedThreadCount:
      input.page === pageCount - 1 ? input.digest.omittedThreadCount : 0,
  };
  const options = {
    channel: channelId,
    text: renderDigest(digest, input.window, input.teamId),
    blocks: renderDigestBlocks(
      digest,
      input.window,
      input.teamId,
      input.digestId,
      markerId,
    ),
    token: input.env.SLACK_BOT_TOKEN,
  };
  await input.beforeWrite();
  const sent = messageTs
    ? await updateSlackMessage({ ...options, ts: messageTs })
    : await postSlackMessage(options);
  if (!sent.id)
    throw new Error("Slack digest delivery did not return a message timestamp");
  return { channelId, messageTs: sent.id, nextCursor: null };
}

export function historyMessageToRecord(
  teamId: string,
  channelId: string,
  message: SlackHistoryMessage,
): SlackMessage {
  const messageTs = message.ts;
  if (!messageTs) throw new Error("Slack history message has no timestamp");
  const editedAt = message.edited?.ts
    ? slackTimestampMs(message.edited.ts)
    : null;

  return {
    teamId,
    channelId,
    messageTs,
    threadTs: message.thread_ts ?? messageTs,
    eventId: `history:${teamId}:${channelId}:${messageTs}:${editedAt ?? 0}`,
    eventTime: editedAt ?? slackTimestampMs(messageTs),
    postedAt: slackTimestampMs(messageTs),
    userId: message.user ?? (message.bot_id ? `bot:${message.bot_id}` : null),
    text: message.text ?? "",
    subtype: message.subtype ?? null,
    editedAt,
    deletedAt: null,
  };
}

export function slackTimestampMs(timestamp: string): number {
  const value = Number.parseFloat(timestamp);
  return Number.isFinite(value) ? Math.round(value * 1_000) : 0;
}
