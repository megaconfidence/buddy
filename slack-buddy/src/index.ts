import { getAgentByName, routeAgentRequest } from "agents";
import { SlackBuddy } from "./agent";

export { SlackBuddy };

/** Single-owner agent: one instance, one name. */
export const OWNER_INSTANCE = "owner";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Liveness probe. Touching the agent runs onStart, which connects MCP
		// and arms the poller, so this doubles as a manual bootstrap.
		if (url.pathname === "/health") {
			const agent = await getAgentByName(env.SlackBuddy, OWNER_INSTANCE);
			await agent.armNextPoll();
			return Response.json({ ok: true, instance: OWNER_INSTANCE });
		}

		return (
			(await routeAgentRequest(request, env)) ??
			new Response("Not found", { status: 404 })
		);
	},

	/**
	 * A Durable Object only exists once something addresses it, and its alarm
	 * is the only thing keeping the poll loop alive. This cron re-anchors both
	 * after a deploy, an eviction, or a dropped alarm. `armNextPoll` cancels
	 * any pending poll first, so repeated pings do not stack alarms.
	 */
	async scheduled(_event: ScheduledController, env: Env): Promise<void> {
		const agent = await getAgentByName(env.SlackBuddy, OWNER_INSTANCE);
		await agent.armNextPoll();
	},
} satisfies ExportedHandler<Env>;
