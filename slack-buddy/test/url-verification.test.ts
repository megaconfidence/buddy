import { describe, expect, it } from "vitest";
import { handleSlackUrlVerification } from "../src/slack/url-verification";

const SECRET = "test-signing-secret";

describe("Slack URL verification", () => {
  it("returns a valid signed challenge without initializing the Slack client", async () => {
    const request = await signedSlackRequest({
      type: "url_verification",
      challenge: "challenge-token",
    });

    const response = await handleSlackUrlVerification(request, SECRET);

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      challenge: "challenge-token",
    });
  });

  it("rejects an invalid URL verification signature immediately", async () => {
    const request = await signedSlackRequest(
      { type: "url_verification", challenge: "challenge-token" },
      "different-secret",
    );

    const response = await handleSlackUrlVerification(request, SECRET);

    expect(response?.status).toBe(401);
  });

  it("leaves normal Slack events for the Chat SDK adapter", async () => {
    const request = await signedSlackRequest({
      type: "event_callback",
      event: { type: "message" },
    });

    await expect(
      handleSlackUrlVerification(request, SECRET),
    ).resolves.toBeNull();
  });
});

async function signedSlackRequest(
  payload: Record<string, unknown>,
  signingSecret = SECRET,
): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = await slackSignature(body, timestamp, signingSecret);
  return new Request("https://slack-buddy.example/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

async function slackSignature(
  body: string,
  timestamp: string,
  signingSecret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`v0:${timestamp}:${body}`),
    ),
  );
  return `v0=${[...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
