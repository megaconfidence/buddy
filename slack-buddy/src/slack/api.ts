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

type SlackUser = {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
};

type SlackHistoryMessage = {
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

export async function syncSlackDirectory(
  env: Env,
  teamId: string,
): Promise<SlackChannel[]> {
  const repository = new SlackBuddyRepository(env.DB);
  const channels = await ensurePublicChannelMembership(env, teamId);

  const users = await listUsers(env.SLACK_BOT_TOKEN);
  await repository.upsertUsers(
    users.map((user) => ({
      teamId,
      userId: user.id,
      displayName: user.profile?.display_name || user.name || null,
      realName: user.profile?.real_name || user.real_name || null,
      isBot: user.is_bot ?? false,
    })),
  );

  return channels;
}

export async function ensurePublicChannelMembership(
  env: Env,
  teamId: string,
): Promise<SlackChannel[]> {
  const channels = await listChannels(env.SLACK_BOT_TOKEN);
  const accessible: SlackChannel[] = [];
  const autoJoin = env.SLACK_BUDDY_AUTO_JOIN_PUBLIC_CHANNELS === "true";

  for (const channel of channels) {
    if (channel.is_archived) continue;

    if (!channel.is_private && !channel.is_member && autoJoin) {
      try {
        await callSlackApi(
          "conversations.join",
          { channel: channel.id },
          { token: env.SLACK_BOT_TOKEN },
        );
        channel.is_member = true;
      } catch (error) {
        if (
          error instanceof SlackApiError &&
          (error.status === 429 || error.response?.error === "ratelimited")
        ) {
          throw error;
        }
        console.warn("Slack Buddy could not join a public Slack channel", {
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
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

export type HistoryReconciliationPage = {
  messageCount: number;
  latestTs: string | null;
  nextCursor: string | null;
};

export async function reconcileChannelHistory(input: {
  env: Env;
  teamId: string;
  channel: SlackChannel;
  startMs: number;
  endMs: number;
  checkpoint?: (
    name: string,
    work: () => Promise<HistoryReconciliationPage>,
  ) => Promise<HistoryReconciliationPage>;
}): Promise<{ messageCount: number; latestTs: string | null }> {
  const repository = new SlackBuddyRepository(input.env.DB);
  const retentionStartMs = retentionCutoffMs(
    input.env.SLACK_BUDDY_RETENTION_DAYS,
  );
  let cursor: string | null = null;
  let messageCount = 0;
  let latestTs: string | null = null;
  let page = 0;
  do {
    const pageCursor = cursor;
    const work = async (): Promise<HistoryReconciliationPage> => {
      const result = await fetchHistoryPage(
        input.env.SLACK_BOT_TOKEN,
        input.channel.id,
        input.startMs,
        input.endMs,
        retentionStartMs,
        pageCursor,
      );
      const records = result.messages.map((message) =>
        historyMessageToRecord(input.teamId, input.channel.id, message),
      );
      await repository.ingestMessages(records);
      const pageLatestTs = records.reduce<string | null>(
        (latest, message) =>
          latest === null || message.messageTs.localeCompare(latest) > 0
            ? message.messageTs
            : latest,
        null,
      );
      if (pageLatestTs) {
        await repository.updateChannelCursor({
          teamId: input.teamId,
          channelId: input.channel.id,
          latestTs: pageLatestTs,
        });
      }
      // Checkpoints contain cursor metadata, never copies of raw Slack history.
      return {
        messageCount: records.length,
        latestTs: pageLatestTs,
        nextCursor: result.nextCursor,
      };
    };
    const result = input.checkpoint
      ? await input.checkpoint(
          `reconcile ${input.channel.id} page ${++page}`,
          work,
        )
      : await work();
    messageCount += result.messageCount;
    if (result.latestTs && (latestTs === null || result.latestTs > latestTs))
      latestTs = result.latestTs;
    cursor = result.nextCursor;
  } while (cursor);
  return { messageCount, latestTs };
}

export async function deliverDigest(input: {
  env: Env;
  digestId: string;
  teamId: string;
  window: DigestWindow;
  digest: StructuredDigest;
  existingChannelId: string | null;
  existingMessageTs: string | null;
}): Promise<{ channelId: string; messageTs: string }> {
  let channelId = input.existingChannelId;
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

  const pageCount = Math.max(1, Math.ceil(input.digest.items.length / 15));
  let firstMessageTs: string | null = null;
  for (let page = 0; page < pageCount; page += 1) {
    const markerId =
      page === 0 ? input.digestId : `${input.digestId}:part:${page + 1}`;
    const digest: StructuredDigest = {
      ...input.digest,
      overview:
        pageCount > 1
          ? `Part ${page + 1}/${pageCount}. ${input.digest.overview}`
          : input.digest.overview,
      items: input.digest.items.slice(page * 15, (page + 1) * 15),
      omittedThreadCount:
        page === pageCount - 1 ? input.digest.omittedThreadCount : 0,
    };
    const messageTs =
      (page === 0 ? input.existingMessageTs : null) ??
      (await findDigestMessage(
        input.env.SLACK_BOT_TOKEN,
        channelId,
        markerId,
        input.window.startMs,
      ));
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
    const sent = messageTs
      ? await updateSlackMessage({ ...options, ts: messageTs })
      : await postSlackMessage(options);
    if (!sent.id)
      throw new Error(
        "Slack digest delivery did not return a message timestamp",
      );
    if (page === 0) firstMessageTs = sent.id;
  }
  return { channelId, messageTs: firstMessageTs! };
}

async function findDigestMessage(
  token: string,
  channelId: string,
  digestId: string,
  oldestMs: number,
): Promise<string | null> {
  let cursor: string | undefined;

  do {
    const result = await callSlackApi<
      SlackApiResponse & {
        messages?: SlackHistoryMessage[];
        response_metadata?: { next_cursor?: string };
      }
    >(
      "conversations.history",
      {
        channel: channelId,
        cursor,
        limit: 100,
        oldest: (oldestMs / 1_000).toFixed(6),
      },
      { token },
    );
    const existing = (result.messages ?? []).find(
      (message) =>
        message.blocks?.some(
          (block) => block.block_id === digestMarkerBlockId(digestId),
        ) && message.ts,
    );
    if (existing?.ts) return existing.ts;
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return null;
}

async function listChannels(token: string): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const result = await callSlackApi<
      SlackApiResponse & {
        channels?: SlackChannel[];
        response_metadata?: { next_cursor?: string };
      }
    >(
      "conversations.list",
      {
        cursor,
        exclude_archived: true,
        limit: 200,
        types: "public_channel,private_channel",
      },
      { token },
    );
    channels.push(...(result.channels ?? []));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels;
}

async function listUsers(token: string): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor: string | undefined;

  do {
    const result = await callSlackApi<
      SlackApiResponse & {
        members?: SlackUser[];
        response_metadata?: { next_cursor?: string };
      }
    >("users.list", { cursor, limit: 200 }, { token });
    users.push(...(result.members ?? []));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return users;
}

async function fetchHistoryPage(
  token: string,
  channelId: string,
  startMs: number,
  endMs: number,
  retentionStartMs: number,
  cursor: string | null,
): Promise<{ messages: SlackHistoryMessage[]; nextCursor: string | null }> {
  const byTimestamp = new Map<string, SlackHistoryMessage>();
  const oldest = (retentionStartMs / 1_000).toFixed(6);
  const latest = (endMs / 1_000).toFixed(6);
  const result = await callSlackApi<
    SlackApiResponse & {
      messages?: SlackHistoryMessage[];
      response_metadata?: { next_cursor?: string };
    }
  >(
    "conversations.history",
    {
      channel: channelId,
      cursor: cursor ?? undefined,
      inclusive: true,
      latest,
      limit: 200,
      // Parent timestamps do not change when a thread gets new replies.
      // Scan older parents too, but retain raw text only inside retention.
    },
    { token },
  );

  for (const message of result.messages ?? []) {
    if (!message.ts) continue;
    if (slackTimestampMs(message.ts) >= retentionStartMs)
      byTimestamp.set(message.ts, message);
    if (
      (message.reply_count ?? 0) > 0 &&
      message.latest_reply &&
      slackTimestampMs(message.latest_reply) >= startMs
    ) {
      for (const reply of await fetchReplies(
        token,
        channelId,
        message.ts,
        oldest,
        latest,
      )) {
        if (reply.ts) byTimestamp.set(reply.ts, reply);
      }
    }
  }
  return {
    messages: [...byTimestamp.values()].filter((message) => {
      const timestamp = slackTimestampMs(message.ts ?? "0");
      return timestamp >= retentionStartMs && timestamp < endMs;
    }),
    nextCursor: result.response_metadata?.next_cursor || null,
  };
}

async function fetchReplies(
  token: string,
  channelId: string,
  threadTs: string,
  oldest: string,
  latest: string,
): Promise<SlackHistoryMessage[]> {
  const replies: SlackHistoryMessage[] = [];
  let cursor: string | undefined;

  do {
    const result = await callSlackApi<
      SlackApiResponse & {
        messages?: SlackHistoryMessage[];
        response_metadata?: { next_cursor?: string };
      }
    >(
      "conversations.replies",
      {
        channel: channelId,
        cursor,
        inclusive: true,
        latest,
        limit: 200,
        oldest,
        ts: threadTs,
      },
      { token },
    );
    replies.push(...(result.messages ?? []));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return replies;
}

function historyMessageToRecord(
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

function slackTimestampMs(timestamp: string): number {
  const value = Number.parseFloat(timestamp);
  return Number.isFinite(value) ? Math.round(value * 1_000) : 0;
}
