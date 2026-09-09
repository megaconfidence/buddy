import { verifySlackSignature } from "@chat-adapter/slack/webhook";

export async function handleSlackUrlVerification(
  request: Request,
  signingSecret: string,
): Promise<Response | null> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return null;
  }

  const body = await request.clone().text();
  const payload = parseJsonObject(body);
  if (payload?.type !== "url_verification") return null;

  try {
    await verifySlackSignature(body, request.headers, { signingSecret });
  } catch {
    return new Response("Invalid signature", { status: 401 });
  }

  if (typeof payload.challenge !== "string" || payload.challenge.length === 0) {
    return new Response("Invalid challenge", { status: 400 });
  }

  return Response.json({ challenge: payload.challenge });
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
