import { getAgentByName, routeAgentRequest } from "agents";
import { SlackBuddy } from "./agent";

export { SlackBuddy };

/** Single-owner agent: one instance, one name. */
export const OWNER_INSTANCE = "owner";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Liveness probe and manual bootstrap. Touching the agent runs
		// onStart, which connects MCP and arms the poller. The diagnostics
		// payload is what makes a broken deployment visible without digging
		// through logs.
		if (url.pathname === "/health") {
			try {
				const agent = await getAgentByName(env.SlackBuddy, OWNER_INSTANCE);

				// onStart only runs on a cold start, so a warm object keeps a
				// broken MCP registration until it is evicted. `?reconnect=1`
				// forces the repair immediately.
				if (url.searchParams.get("reconnect") === "1") {
					await agent.connectSlack(true);
				}

				// `?poll=1` runs a poll immediately instead of waiting for the
				// armed alarm, which during idle hours is up to 15 minutes out.
				if (url.searchParams.get("poll") === "1") {
					await agent.pollNow();
				}

				// Maintenance: forget what has already been briefed, so items
				// can resurface. Needed after a bad triage run.
				if (url.searchParams.get("reset") === "seen") {
					await agent.clearSeen();
				}

				// `?digest=1` runs the daily sweep now. The run id is distinct
				// from a scheduled one so a manual run cannot collide with, or
				// suppress, the 08:30 occurrence. `&hours=N` overrides the
				// lookback window, which otherwise starts at the last run.
				if (url.searchParams.get("digest") === "1") {
					const hours = Number(url.searchParams.get("hours"));
					await agent.runDailyDigest(
						`manual-${Date.now()}`,
						Number.isFinite(hours) && hours > 0
							? Date.now() - hours * 3_600_000
							: undefined,
					);
				}

				await agent.armNextPoll();
				const report = (await agent.diagnostics()) as Record<string, unknown>;
				return Response.json({
					ok: true,
					instance: OWNER_INSTANCE,
					...report,
				});
			} catch (error) {
				// Surface boot failures instead of returning a 500 with no
				// detail; onStart problems are otherwise invisible.
				return Response.json(
					{
						ok: false,
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					},
					{ status: 500 },
				);
			}
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
