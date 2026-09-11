import type { Env } from "./env";
import { appFetch } from "./web/router";
import { scheduledBriefing } from "./mcp/service";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return appFetch(request, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(scheduledBriefing(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
