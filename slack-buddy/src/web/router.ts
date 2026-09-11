import { z } from "zod";
import type { Env } from "../env";
import {
  authenticated,
  login,
  cookie,
  sameOrigin,
  deliveryToken,
  verifyDelivery,
} from "./auth";
import { AppStore } from "../mcp/store";
import { settingsSchema } from "../mcp/settings";
import { briefingSchema } from "../mcp/model";
import { generateBriefing, sendBriefing } from "../mcp/service";
import { renderApp } from "./ui";

const ERROR_MESSAGES: Record<string, string> = {
  web_not_configured:
    "The private app needs its owner login secret configured.",
  login_failed: "That login secret was not accepted.",
  login_limited: "Too many login attempts. Try again in ten minutes.",
  run_busy:
    "A briefing is already running. Please wait a few minutes before trying again.",
  run_exists:
    "This request has already been processed. Generate a new briefing to try again.",
  settings_conflict:
    "Settings changed in another window. Reload before saving.",
  delivery_already_attempted:
    "Delivery was already attempted. Check Slack and the run status before taking further action.",
  delivery_uncertain:
    "Slack may have received some or all of the briefing. Check Slack; this app will not automatically resend it.",
  generation_failed:
    "The briefing could not be generated. No message was sent. Try again shortly.",
  authentication: "The Slack connector needs its authorization checked.",
  rate_limit: "The Slack connector is rate limited. Try again later.",
};
async function jsonBody(request: Request) {
  if (!request.headers.get("Content-Type")?.includes("application/json"))
    throw new Error("invalid_request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > 100_000) {
        await reader.cancel();
        throw new Error("invalid_request");
      }
      chunks.push(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let i = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, i);
    i += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid_request");
  }
}
export async function appFetch(request: Request, env: Env): Promise<Response> {
  let response: Response;
  try {
    response = await route(request, env);
  } catch (error) {
    const code =
      error instanceof z.ZodError
        ? "invalid_request"
        : error instanceof Error
          ? error.message
          : "unknown";
    const status =
      code === "login_failed"
        ? 401
        : code === "login_limited"
          ? 429
          : [
                "run_busy",
                "run_exists",
                "settings_conflict",
                "delivery_already_attempted",
              ].includes(code)
            ? 409
            : code === "invalid_request"
              ? 400
              : 503;
    response = Response.json(
      {
        error:
          ERROR_MESSAGES[code] ??
          "The request could not be completed. Check the input and try again.",
        code: code in ERROR_MESSAGES ? code : "invalid_request",
      },
      { status },
    );
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return response;
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/favicon.ico")
    return new Response(null, { status: 204 });
  if (request.method === "GET" && url.pathname === "/health")
    return Response.json({ name: "Slack Buddy", status: "ok", mode: "mcp" });
  if (request.method === "GET" && url.pathname === "/") {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    return new Response(renderApp(nonce), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      },
    });
  }
  if (!url.pathname.startsWith("/api/"))
    return new Response("Not found", { status: 404 });
  if (
    !env.SLACK_USER_ID ||
    !env.MISTRAL_API_KEY ||
    !env.SLACK_BUDDY_WEB_SECRET ||
    env.SLACK_BUDDY_WEB_SECRET.length < 32
  )
    throw new Error("web_not_configured");
  if (request.method !== "GET" && !sameOrigin(request))
    return Response.json(
      { error: "Request origin not accepted." },
      { status: 403 },
    );
  if (url.pathname === "/api/login" && request.method === "POST") {
    const input = z
      .object({ password: z.string().max(256) })
      .parse(await jsonBody(request));
    const token = await login(request, env, input.password);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": cookie(request, env, token) } },
    );
  }
  if (!(await authenticated(request, env)))
    return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (url.pathname === "/api/logout" && request.method === "POST")
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": cookie(request, env, "") } },
    );
  const store = new AppStore(env.DB, env.SLACK_USER_ID);
  if (url.pathname === "/api/state" && request.method === "GET")
    return Response.json({
      ...(await store.settings()),
      runs: await store.runs(),
      scheduledAvailable: env.SLACK_BUDDY_SCHEDULED_MCP_ENABLED === "true",
    });
  if (url.pathname === "/api/settings" && request.method === "POST") {
    const input = z
      .object({
        version: z.number().int().nonnegative(),
        settings: settingsSchema,
      })
      .parse(await jsonBody(request));
    if (
      input.settings.dailyDelivery &&
      env.SLACK_BUDDY_SCHEDULED_MCP_ENABLED !== "true"
    )
      return Response.json(
        {
          error:
            "Scheduled connector access must be enabled by the app operator first.",
        },
        { status: 400 },
      );
    return Response.json(await store.save(input.settings, input.version));
  }
  if (url.pathname === "/api/generate" && request.method === "POST") {
    const input = z
      .object({
        requestId: z.uuid(),
        question: z.string().trim().min(3).max(1500).optional(),
        conversation: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().max(2500),
            }),
          )
          .max(6)
          .optional(),
        days: z.number().int().min(1).max(7).default(1),
      })
      .parse(await jsonBody(request));
    const end = Date.now();
    const result = await generateBriefing(env, {
      id: input.requestId,
      question: input.question,
      conversation: input.conversation,
      start: end - input.days * 86_400_000,
      end,
      kind: input.question ? "research" : "briefing",
    });
    const delivery = {
      briefing: result.briefing,
      window: result.window,
      partial: result.metrics.partial,
    };
    return Response.json({
      ...result,
      deliveryToken: await deliveryToken(env, result.runId, delivery),
    });
  }
  if (url.pathname === "/api/send" && request.method === "POST") {
    const raw = await jsonBody(request);
    const input = z
      .object({
        runId: z.uuid(),
        token: z.string().max(3000),
        payload: z.object({
          briefing: briefingSchema,
          window: z.object({ start: z.number(), end: z.number() }),
          partial: z.boolean(),
        }),
      })
      .parse(raw);
    if (!(await verifyDelivery(env, input.token, input.runId, raw.payload)))
      return Response.json(
        {
          error:
            "This briefing has changed or its delivery authorization expired. Generate it again.",
        },
        { status: 403 },
      );
    return Response.json(
      await sendBriefing(
        env,
        input.runId,
        input.payload.briefing,
        input.payload.window,
        input.payload.partial,
      ),
    );
  }
  return new Response("Not found", { status: 404 });
}
