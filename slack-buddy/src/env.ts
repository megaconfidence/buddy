import type { ChatStateDO } from "chat-state-cloudflare-do";
import type { SlackBuddyAgent } from "./agent";
import type { SlackJobParams } from "./domain/jobs";

export interface Env extends Cloudflare.Env {
  DB: D1Database;
  SLACK_BUDDY_AGENT: DurableObjectNamespace<SlackBuddyAgent>;
  CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
  DIGEST_WORKFLOW: Workflow<SlackJobParams>;

  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_USER_ID: string;
  MISTRAL_API_KEY: string;

  SLACK_BUDDY_TIMEZONE: string;
  SLACK_BUDDY_DIGEST_HOUR: string;
  SLACK_BUDDY_AUTO_JOIN_PUBLIC_CHANNELS: string;
  SLACK_BUDDY_RETENTION_DAYS: string;
  SLACK_BUDDY_RECONCILE_HOURS: string;
  SLACK_BUDDY_DIRECTORY_REFRESH_HOURS: string;
  SLACK_BUDDY_FULL_SCAN_DAYS: string;
  SLACK_BUDDY_JOB_PHASES: string;
  MISTRAL_MODEL: string;
}
