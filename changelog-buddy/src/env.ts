import type { DigestWorkflowParams, ScanWorkflowParams } from "./domain/types";

export interface Env extends Cloudflare.Env {
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
  SCAN_WORKFLOW: Workflow<ScanWorkflowParams>;
  DIGEST_WORKFLOW: Workflow<DigestWorkflowParams>;

  MISTRAL_API_KEY: string;
  RESEND_API_KEY: string;
  EMAIL_TO: string;
  EMAIL_FROM: string;
  FEEDBACK_SECRET: string;
  PUBLIC_BASE_URL: string;
  GITHUB_TOKEN?: string;

  BUDDY_TIMEZONE: string;
  BUDDY_DIGEST_HOUR: string;
  MISTRAL_MODEL: string;
  CHANGE_RETENTION_DAYS: string;
}
