import type { RenderedEmail } from "./render";
import type { Env } from "../env";
import { MISTRAL_LOGO_BASE64 } from "./mistral-logo";

type ResendResponse = {
  id?: string;
  name?: string;
  message?: string;
  statusCode?: number;
};

export class ResendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export class ResendPermanentError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export async function sendDigestEmail(
  env: Env,
  digestId: string,
  email: RenderedEmail,
): Promise<string> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `changelog-buddy/${digestId}`,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [env.EMAIL_TO],
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: [
        {
          content: MISTRAL_LOGO_BASE64,
          filename: "Mistral-Lockup-Gradient-RGB.png",
          content_type: "image/png",
          content_id: "mistral-logo",
        },
      ],
      tags: [
        { name: "application", value: "changelog-buddy" },
        { name: "digest", value: digestId.slice(0, 256) },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json().catch(() => ({}))) as ResendResponse;
  if (!response.ok || !result.id) {
    const message = result.message ?? `Resend returned HTTP ${response.status}`;
    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      result.name === "concurrent_idempotent_requests";
    if (!retryable) {
      throw new ResendPermanentError(message, result.name ?? null);
    }
    const retryAfter = response.headers.get("retry-after");
    throw new ResendError(
      `${message}${retryAfter ? `; retry-after=${retryAfter}` : ""}`,
      response.status,
      result.name ?? null,
    );
  }
  return result.id;
}
