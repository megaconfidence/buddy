import type { ChatStateDO } from "chat-state-cloudflare-do";
import type { BuddyAgent } from "./agent";
import type { DigestWorkflowParams } from "./domain/types";

export interface Env extends Cloudflare.Env {
  DB: D1Database;
  BUDDY_AGENT: DurableObjectNamespace<BuddyAgent>;
  CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
  DIGEST_WORKFLOW: Workflow<DigestWorkflowParams>;

  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_USER_ID: string;
  MISTRAL_API_KEY: string;

  BUDDY_TIMEZONE: string;
  BUDDY_DIGEST_HOUR: string;
  BUDDY_AUTO_JOIN_PUBLIC_CHANNELS: string;
  BUDDY_RETENTION_DAYS: string;
  BUDDY_RECONCILE_HOURS: string;
  MISTRAL_MODEL: string;
}
