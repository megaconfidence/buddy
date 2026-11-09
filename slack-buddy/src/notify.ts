import { isSlackPermalink } from "./slack/parse";

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
 * The workflow takes one text variable, `message`. Its URL is the optional
 * `SLACK_WORKFLOW_URL` secret; without it nothing is sent.
 */

const TIMEOUT_MS = 10_000;

/**
 * Notify the owner of a message, with a link to it when there is one.
 *
 * Never throws, so a notification that fails cannot fail the briefing it
 * announces. Returns whether the workflow accepted it.
 */
export async function notifyOwner(
	url: string | undefined,
	text: string,
	link: string | null,
	fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
	if (!url) return false;
	const message = isSlackPermalink(link) ? `${text}\n${link}` : text;
	try {
		const response = await fetcher(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message }),
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
