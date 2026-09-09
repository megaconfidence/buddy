import { createSlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import { getAgentByName } from "agents";
import {
  Chat,
  type ActionEvent,
  type Message,
  type MessageContext,
  type Thread,
} from "chat";
import {
  createCloudflareState,
  type ChatStateDO,
} from "chat-state-cloudflare-do";
import type { SlackBuddyAgent } from "../agent";
import type { SlackMessage } from "../domain/types";
import type { Env } from "../env";
import { SlackBuddyRepository } from "../storage/repository";
import { CLOUDFLARE_SLACK_WEB_CLIENT_OPTIONS } from "./web-client";
import { FEEDBACK_ACTION_IDS } from "./feedback";

const ALL_MESSAGES = /[\s\S]*/u;

export function createSlackBuddyChat(env: Env) {
  const slack = createSlackAdapter({
    botToken: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    nativeStreaming: true,
    webClientOptions: CLOUDFLARE_SLACK_WEB_CLIENT_OPTIONS,
  });
  const bot = new Chat({
    userName: "slack-buddy",
    adapters: { slack },
    state: createCloudflareState({
      namespace: env.CHAT_STATE as DurableObjectNamespace<ChatStateDO>,
      shardKey: (threadId) => threadId.split(":").slice(0, 2).join(":"),
    }),
    concurrency: "concurrent",
    dedupeTtlMs: 86_400_000,
    logger: "warn",
  });

  const ingest = async (
    thread: Thread,
    message: Message,
    context?: MessageContext,
  ) => {
    if (thread.isDM) return;
    for (const candidate of [...(context?.skipped ?? []), message]) {
      await ingestMessage(env, thread, candidate);
    }
  };

  bot.onNewMessage(ALL_MESSAGES, ingest);
  bot.onNewMention(ingest);
  bot.onSubscribedMessage(ingest);

  bot.onMessageUpdated(async (thread, message) => {
    if (!thread.isDM) await ingestMessage(env, thread, message);
  });

  bot.onMessageDeleted(async (event) => {
    const raw = event.raw as SlackEvent;
    const teamId = raw.team_id ?? raw.team;
    if (!teamId) throw new Error("Slack delete event is missing team_id");

    await new SlackBuddyRepository(env.DB).deleteMessage({
      eventId: eventKey(
        teamId,
        event.channelId,
        raw.event_ts ?? event.messageId,
        "deleted",
      ),
      teamId,
      channelId: event.channelId,
      messageTs: event.messageId,
      eventTime: slackTimestampMs(raw.event_ts ?? event.messageId),
    });
  });

  bot.onDirectMessage(async (thread, message, _channel, context) => {
    if (message.author.userId !== env.SLACK_USER_ID) return;

    const raw = message.raw as SlackEvent;
    const teamId = raw.team_id ?? raw.team;
    if (!teamId) throw new Error("Slack DM event is missing team_id");

    const agent = await getAgentByName<Env, SlackBuddyAgent>(
      env.SLACK_BUDDY_AGENT,
      slackBuddyAgentName(teamId, env.SLACK_USER_ID),
    );
    await agent.configureForUser({
      teamId,
      userId: env.SLACK_USER_ID,
    });

    const messages = [...(context?.skipped ?? []), message];
    const prompt = messages.map((item) => item.text).join("\n\n");
    await thread.startTyping();
    const text = await agent.answer(prompt);
    await thread.post({
      markdown:
        text || "I couldn't produce a response. Please try again in a moment.",
    });
  });

  // Keep accepting controls on briefings delivered before action IDs were split.
  for (const actionId of [
    "slack_buddy_feedback",
    ...Object.values(FEEDBACK_ACTION_IDS),
  ]) {
    bot.onAction(actionId, async (event) => {
      await handleFeedback(env, event);
    });
  }

  return bot;
}

export function slackBuddyAgentName(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

async function ingestMessage(
  env: Env,
  thread: Thread,
  message: Message,
): Promise<void> {
  const raw = message.raw as SlackEvent;
  const teamId = raw.team_id ?? raw.team;
  const channelId = raw.channel ?? thread.channelId;
  const messageTs = raw.ts ?? message.id;
  if (!teamId || !channelId || !messageTs) {
    throw new Error(
      "Slack message is missing a workspace, channel, or timestamp",
    );
  }

  const eventTs = raw.event_ts ?? raw.edited?.ts ?? messageTs;
  const repository = new SlackBuddyRepository(env.DB);
  await repository.upsertUser({
    teamId,
    userId: message.author.userId,
    displayName: message.author.userName || null,
    realName: message.author.fullName || null,
    isBot: message.author.isBot === true,
  });
  await repository.touchChannel({
    teamId,
    channelId,
    name: thread.channel.name,
  });
  await repository.ingestMessage(
    toSlackMessage(teamId, channelId, eventTs, raw, message),
  );
}

export function toSlackMessage(
  teamId: string,
  channelId: string,
  eventTs: string,
  raw: SlackEvent,
  message: Message,
): SlackMessage {
  const messageTs = raw.ts ?? message.id;
  return {
    teamId,
    channelId,
    messageTs,
    threadTs: raw.thread_ts ?? messageTs,
    eventId: eventKey(teamId, channelId, eventTs, raw.subtype ?? raw.type),
    eventTime: slackTimestampMs(eventTs),
    postedAt: message.metadata.dateSent.getTime(),
    userId: message.author.userId || raw.user || null,
    text: raw.text ?? message.text,
    subtype: raw.subtype ?? null,
    editedAt: message.metadata.editedAt?.getTime() ?? null,
    deletedAt: null,
  };
}

async function handleFeedback(env: Env, event: ActionEvent): Promise<void> {
  if (event.user.userId !== env.SLACK_USER_ID || !event.value) return;

  const value = parseFeedbackValue(event.value);
  if (!value) return;

  const raw = event.raw as {
    team?: { id?: string };
    team_id?: string;
  };
  const teamId = raw.team?.id ?? raw.team_id;
  if (!teamId) throw new Error("Slack feedback event is missing team_id");

  const agent = await getAgentByName<Env, SlackBuddyAgent>(
    env.SLACK_BUDDY_AGENT,
    slackBuddyAgentName(teamId, env.SLACK_USER_ID),
  );
  await agent.configureForUser({ teamId, userId: env.SLACK_USER_ID });
  await agent.applyFeedback({
    feedbackId: crypto.randomUUID(),
    teamId,
    userId: env.SLACK_USER_ID,
    digestId: value.digestId,
    itemId: value.itemId,
    value: value.value,
  });

  if (event.thread) {
    await event.thread.postEphemeral(
      event.user,
      value.value === "handled"
        ? "Marked as handled."
        : "Thanks — Slack Buddy will use that feedback in future briefings.",
      { fallbackToDM: true },
    );
  }
}

function parseFeedbackValue(value: string): {
  digestId: string;
  itemId: string | null;
  value: "relevant" | "not_relevant" | "handled";
} | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.digestId !== "string" ||
      !["relevant", "not_relevant", "handled"].includes(String(parsed.value))
    ) {
      return null;
    }
    return {
      digestId: parsed.digestId,
      itemId: typeof parsed.itemId === "string" ? parsed.itemId : null,
      value: parsed.value as "relevant" | "not_relevant" | "handled",
    };
  } catch {
    return null;
  }
}

function eventKey(
  teamId: string,
  channelId: string,
  eventTs: string,
  kind: string,
): string {
  return `${teamId}:${channelId}:${eventTs}:${kind}`;
}

function slackTimestampMs(timestamp: string): number {
  const value = Number.parseFloat(timestamp);
  return Number.isFinite(value) ? Math.round(value * 1_000) : Date.now();
}
