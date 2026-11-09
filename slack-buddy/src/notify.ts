/**
 * Notifications through a Slack workflow.
 *
 * Everything the agent posts goes out under the owner's own account, and
 * Slack never notifies anyone about their own messages, so a briefing arrives
 * silently. A Workflow Builder workflow started by a webhook can DM the owner
 * instead: its message comes from the workflow, so Slack notifies as for any
 * other DM. No Slack app is involved, and the webhook does not go through the
 * MCP gateway, so it still works when the gateway does not.
 *
 * The workflow takes one text variable, `message`, and inserts it as typed:
 * Markdown is not rendered, and only bare URLs become links. So the agent
 * posts the briefing itself into the workflow's DM, and the workflow sends
 * the one-liners. Its URL is the optional `SLACK_WORKFLOW_URL` secret;
 * without it nothing is sent.
 */

const TIMEOUT_MS = 10_000;

/**
 * Send the owner a plain-text message through the workflow.
 *
 * Never throws, so a notification that fails cannot fail the briefing it
 * announces. Returns whether the workflow accepted it.
 */
export async function notifyOwner(
	url: string | undefined,
	text: string,
	fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
	if (!url) return false;
	try {
		const response = await fetcher(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: text }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const body = await response.text();
		if (response.ok && !/"ok"\s*:\s*false/.test(body)) return true;
		console.error(`Slack workflow refused the notification: ${response.status} ${body.slice(0, 200)}`);
	} catch (error) {
		// The URL is a credential: anyone holding it can make the workflow DM the owner.
		console.error(`Slack workflow unreachable: ${String(error).replaceAll(url, "<SLACK_WORKFLOW_URL>")}`);
	}
	return false;
}
