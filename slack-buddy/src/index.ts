import type { Env } from "./env";
import { reconcileDigestSchedule } from "./scheduler";
import { createSlackBuddyChat } from "./slack/bot";
import { handleSlackUrlVerification } from "./slack/url-verification";

export { SlackBuddyAgent } from "./agent";
export { SlackBuddyDigestWorkflow } from "./workflows/digest";
export { ChatStateDO } from "chat-state-cloudflare-do";

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        name: "Slack Buddy",
        status: "ok",
        model: env.MISTRAL_MODEL,
      });
    }

    if (request.method === "POST" && url.pathname === "/webhooks/slack") {
      assertConfigured(env);
      const verification = await handleSlackUrlVerification(
        request,
        env.SLACK_SIGNING_SECRET,
      );
      if (verification) return verification;

      const bot = createSlackBuddyChat(env);
      return bot.webhooks.slack(request, {
        waitUntil: (task) => context.waitUntil(task),
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(reconcileDigestSchedule(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

function assertConfigured(env: Env): void {
  const required = [
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "SLACK_USER_ID",
    "MISTRAL_API_KEY",
  ] as const;
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  }
}
