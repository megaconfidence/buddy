import { coordinate } from "./coordinator";
import type { Env } from "./env";
import { handleFeedback } from "./feedback/handler";

export { SourceScanWorkflow } from "./workflows/scan";
export { DigestWorkflow } from "./workflows/digest";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        name: "Changelog Buddy",
        status: "ok",
        model: env.MISTRAL_MODEL,
      });
    }
    if (
      url.pathname === "/feedback" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      assertFeedbackConfigured(env);
      return handleFeedback(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _context: ExecutionContext,
  ): Promise<void> {
    assertConfigured(env);
    await coordinate(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;

function assertConfigured(env: Env): void {
  const required = [
    "MISTRAL_API_KEY",
    "RESEND_API_KEY",
    "EMAIL_TO",
    "EMAIL_FROM",
    "FEEDBACK_SECRET",
    "PUBLIC_BASE_URL",
  ] as const;
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
  const publicUrl = new URL(env.PUBLIC_BASE_URL);
  if (publicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS");
  }
  assertFeedbackConfigured(env);
}

function assertFeedbackConfigured(env: Env): void {
  if (!env.FEEDBACK_SECRET || env.FEEDBACK_SECRET.length < 32) {
    throw new Error("FEEDBACK_SECRET must contain at least 32 characters");
  }
}
