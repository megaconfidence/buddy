import type { DigestWorkflowParams } from "./types";
import type { SlackChannel } from "../slack/api";

export type SlackJobPhase =
  | { kind: "start" }
  | { kind: "users"; cursor: string | null }
  | { kind: "channels"; cursor: string | null }
  | {
      kind: "membership";
      channels: SlackChannel[];
      offset: number;
      nextCursor: string | null;
    }
  | { kind: "history"; channelId: string | null; cursor: string | null }
  | { kind: "replies"; threadKey: string | null; cursor: string | null }
  | { kind: "prepare" }
  | { kind: "rank"; batch: number }
  | { kind: "synthesize" }
  | {
      kind: "deliver";
      page: number;
      channelId: string | null;
      cursor: string | null;
    };

export type SlackJobParams = {
  protocol: "free-v1";
  runKey: string;
  teamId: string;
  userId: string;
  digest: DigestWorkflowParams | null;
  sequence: number;
  phase: SlackJobPhase;
};

export async function slackJobId(
  runKey: string,
  sequence: number,
): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runKey)),
  );
  const prefix = Array.from(hash.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `slack-buddy-free-v1-${prefix}-${sequence}`;
}

export function initialDigestJob(digest: DigestWorkflowParams): SlackJobParams {
  return {
    protocol: "free-v1",
    runKey: digest.digestId,
    teamId: digest.teamId,
    userId: digest.userId,
    digest,
    sequence: 0,
    phase: { kind: "start" },
  };
}
