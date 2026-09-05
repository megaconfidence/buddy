import { sha256 } from "../domain/hash";
import type { Env } from "../env";
import { ChangelogRepository } from "../storage/repository";
import { verifyFeedbackToken } from "./tokens";

export async function handleFeedback(
  request: Request,
  env: Env,
): Promise<Response> {
  const token =
    request.method === "POST"
      ? (await request.formData()).get("token")?.toString()
      : new URL(request.url).searchParams.get("token");
  if (!token)
    return page("Invalid feedback link", "This link is incomplete.", 400);

  const payload = await verifyFeedbackToken(env.FEEDBACK_SECRET, token);
  if (!payload) {
    return page(
      "Feedback link expired",
      "This feedback link is invalid or has expired.",
      400,
    );
  }

  if (request.method === "GET") {
    return new Response(
      `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:20px">
        <h1>Confirm feedback</h1>
        <p>Record this item as <strong>${label(payload.value)}</strong>?</p>
        <form method="post">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <button style="background:#111827;color:white;border:0;border-radius:8px;padding:10px 16px;cursor:pointer" type="submit">Confirm</button>
        </form>
      </body></html>`,
      { headers: htmlHeaders() },
    );
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, POST" },
    });
  }

  const recorded = await new ChangelogRepository(env.DB).recordFeedback({
    id: `feedback:${await sha256(token)}`,
    digestId: payload.digestId,
    itemId: payload.itemId,
    value: payload.value,
  });
  return recorded
    ? page(
        "Feedback saved",
        `Thanks — Changelog Buddy recorded this as ${label(payload.value)}.`,
      )
    : page(
        "Digest item not found",
        "This digest item is no longer available.",
        404,
      );
}

function page(title: string, message: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:20px">
      <h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
    </body></html>`,
    {
      status,
      headers: htmlHeaders(),
    },
  );
}

function htmlHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
  });
}

function label(value: "pursue" | "not_relevant" | "handled"): string {
  return {
    pursue: "worth pursuing",
    not_relevant: "not relevant",
    handled: "handled",
  }[value];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
