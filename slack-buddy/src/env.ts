export interface Env {
  DB: D1Database;
  SLACK_USER_ID: string;
  MISTRAL_API_KEY: string;
  MISTRAL_MODEL: string;
  /** A random 32+ character owner login secret; also signs short-lived sessions. */
  SLACK_BUDDY_WEB_SECRET?: string;
  /** Enable when unattended retrieval is supported for this connector. */
  SLACK_BUDDY_SCHEDULED_MCP_ENABLED?: string;
  /** Allows HTTP cookies on loopback addresses during local development only. */
  SLACK_BUDDY_LOCAL_DEV?: string;
}
