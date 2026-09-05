import {
  callSlackApi,
  postSlackMessage,
  SlackApiError,
  updateSlackMessage,
  type SlackApiResponse,
} from "@chat-adapter/slack/api";
import type {
  DigestWindow,
  SlackMessage,
  StructuredDigest,
} from "../domain/types";
import type { Env } from "../env";
import { BuddyRepository } from "../storage/repository";
import { renderDigest, renderDigestBlocks } from "./render";

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
  bot_id?: string;
  edited?: { ts?: string };
  reply_count?: number;
  latest_reply?: string;
  metadata?: {
    event_type?: string;
    event_payload?: {
      digest_id?: string;
    };
  };
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
  const repository = new BuddyRepository(env.DB);
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
  const autoJoin = env.BUDDY_AUTO_JOIN_PUBLIC_CHANNELS === "true";

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
        console.warn("Buddy could not join a public Slack channel", {
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (channel.is_member) accessible.push(channel);
  }

  await new BuddyRepository(env.DB).upsertChannels(
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

export async function reconcileChannelHistory(input: {
  env: Env;
  teamId: string;
  channel: SlackChannel;
  startMs: number;
  endMs: number;
}): Promise<{ messageCount: number; latestTs: string | null }> {
  const messages = await fetchHistoryWindow(
    input.env.SLACK_BOT_TOKEN,
    input.channel.id,
    input.startMs,
    input.endMs,
  );
  const repository = new BuddyRepository(input.env.DB);
  const records = messages
    .filter((message): message is SlackHistoryMessage & { ts: string } =>
      Boolean(message.ts),
    )
    .map((message) =>
      historyMessageToRecord(input.teamId, input.channel.id, message),
    );
  await repository.ingestMessages(records);
  const latestTs = records.reduce<string | null>(
    (latest, message) =>
      latest === null || message.messageTs.localeCompare(latest) > 0
        ? message.messageTs
        : latest,
    null,
  );

  if (latestTs) {
    await repository.updateChannelCursor({
      teamId: input.teamId,
      channelId: input.channel.id,
      latestTs,
    });
  }

  return { messageCount: messages.length, latestTs };
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
  const markdown = renderDigest(input.digest, input.window, input.teamId);
  const blocks = renderDigestBlocks(
    input.digest,
    input.window,
    input.teamId,
    input.digestId,
  );

  if (input.existingChannelId && input.existingMessageTs) {
    const updated = await updateSlackMessage({
      channel: input.existingChannelId,
      ts: input.existingMessageTs,
      text: markdown,
      blocks,
      token: input.env.SLACK_BOT_TOKEN,
    });
    return {
      channelId: updated.channel ?? input.existingChannelId,
      messageTs: updated.id || input.existingMessageTs,
    };
  }

  const dm = await callSlackApi<
    SlackApiResponse & { channel?: { id?: string } }
  >(
    "conversations.open",
    { users: input.env.SLACK_USER_ID },
    { token: input.env.SLACK_BOT_TOKEN },
  );
  const channelId = dm.channel?.id;
  if (!channelId) {
    throw new Error("Slack conversations.open did not return a DM channel");
  }

  const recoveredMessageTs = await findDigestMessage(
    input.env.SLACK_BOT_TOKEN,
    channelId,
    input.digestId,
    input.window.startMs,
  );
  if (recoveredMessageTs) {
    const updated = await updateSlackMessage({
      channel: channelId,
      ts: recoveredMessageTs,
      text: markdown,
      blocks,
      token: input.env.SLACK_BOT_TOKEN,
    });
    return {
      channelId: updated.channel ?? channelId,
      messageTs: updated.id || recoveredMessageTs,
    };
  }

  const posted = await postSlackMessage({
    channel: channelId,
    text: markdown,
    blocks,
    metadata: {
      event_type: "buddy.daily_digest",
      event_payload: { digest_id: input.digestId },
    },
    token: input.env.SLACK_BOT_TOKEN,
  });
  return {
    channelId: posted.channel ?? channelId,
    messageTs: posted.id,
  };
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
        include_all_metadata: true,
        limit: 100,
        oldest: (oldestMs / 1_000).toFixed(6),
      },
      { token },
    );
    const existing = (result.messages ?? []).find(
      (message) =>
        message.metadata?.event_type === "buddy.daily_digest" &&
        message.metadata.event_payload?.digest_id === digestId &&
        message.ts,
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

async function fetchHistoryWindow(
  token: string,
  channelId: string,
  startMs: number,
  endMs: number,
): Promise<SlackHistoryMessage[]> {
  const byTimestamp = new Map<string, SlackHistoryMessage>();
  let cursor: string | undefined;
  const oldest = (startMs / 1_000).toFixed(6);
  const latest = (endMs / 1_000).toFixed(6);

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
        inclusive: true,
        latest,
        limit: 200,
        oldest,
      },
      { token },
    );

    for (const message of result.messages ?? []) {
      if (!message.ts) continue;
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

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return [...byTimestamp.values()].filter((message) => {
    const timestamp = slackTimestampMs(message.ts ?? "0");
    return timestamp >= startMs && timestamp < endMs;
  });
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
