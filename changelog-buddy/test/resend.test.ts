import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { ResendPermanentError, sendDigestEmail } from "../src/email/resend";

afterEach(() => vi.unstubAllGlobals());

describe("Resend delivery", () => {
  it("uses a deterministic idempotency key", async () => {
    let idempotencyKey: string | null = null;
    let requestBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        idempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ id: "email-123" }, { status: 201 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const id = await sendDigestEmail(
      {
        RESEND_API_KEY: "re_test",
        EMAIL_FROM: "Buddy <buddy@example.com>",
        EMAIL_TO: "developer@example.com",
      } as Env,
      "digest-2026-09-05",
      {
        subject: "Digest",
        html: "<p>Digest</p>",
        text: "Digest",
        eventIds: [],
      },
    );

    expect(id).toBe("email-123");
    expect(idempotencyKey).toBe("changelog-buddy/digest-2026-09-05");
    const sentBody = requestBody as unknown as {
      attachments?: unknown[];
    };
    expect(sentBody.attachments).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/u),
        filename: "Mistral-Lockup-Gradient-RGB.png",
        content_type: "image/png",
        content_id: "mistral-logo",
      }),
    ]);
  });

  it("marks permanent provider failures as non-retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { name: "validation_error", message: "Invalid sender" },
          { status: 403 },
        ),
      ),
    );

    await expect(
      sendDigestEmail(
        {
          RESEND_API_KEY: "re_test",
          EMAIL_FROM: "Buddy <buddy@example.com>",
          EMAIL_TO: "developer@example.com",
        } as Env,
        "digest-1",
        {
          subject: "Digest",
          html: "<p>Digest</p>",
          text: "Digest",
          eventIds: [],
        },
      ),
    ).rejects.toBeInstanceOf(ResendPermanentError);
  });
});
