import type { ToolSet } from "ai";

/**
 * Stable MCP server id. Determines the namespace the Agents SDK gives every
 * tool it imports: `tool_{serverId}_{toolName}`.
 */
export const MCP_SERVER_ID = "slack";

const namespace = (tool: string) =>
	`tool_${MCP_SERVER_ID.replace(/-/g, "")}_${tool}`;

/**
 * The only gateway tools the model may call. All are read-only.
 */
export const READ_ONLY_TOOLS = [
	"slack_search_public",
	"slack_search_public_and_private",
	"slack_search_channels",
	"slack_search_users",
	"slack_read_channel",
	"slack_read_thread",
	"slack_read_canvas",
	"slack_read_user_profile",
	"slack_list_channel_members",
	"slack_read_file",
	"slack_get_reactions",
	"slack_search_emojis",
] as const;

/**
 * Gateway tools that mutate Slack. These run under a user token with
 * workspace-wide reach, so they are never handed to the model. The app calls
 * the ones it needs directly through `mcp.callTool`, with the destination
 * fixed in code.
 */
export const WRITE_TOOLS = [
	"slack_send_message",
	"slack_schedule_message",
	"slack_send_message_draft",
	"slack_add_reaction",
	"slack_create_conversation",
	"slack_create_canvas",
	"slack_update_canvas",
] as const;

export const READ_ONLY_ALLOWLIST: ReadonlySet<string> = new Set(
	READ_ONLY_TOOLS.map(namespace),
);

const FORBIDDEN: ReadonlySet<string> = new Set(WRITE_TOOLS.map(namespace));

export class ToolPolicyError extends Error {}

export type ToolPolicyResult = {
	/** Tools safe to hand to the model. Never contains a write tool. */
	tools: ToolSet;
	/**
	 * Allowlisted tools absent from the catalog.
	 *
	 * Non-empty usually means MCP discovery has not finished yet, not that
	 * anything is wrong. It is a readiness signal, not a policy violation.
	 */
	missing: string[];
};

/**
 * Reduce a full MCP tool set to the allowlist.
 *
 * Think's `includeMcpTools` defaults to true and would otherwise merge every
 * connected tool into the model turn. The agent disables that and routes tools
 * through here instead, so this function is the enforcement point for the
 * whole design.
 *
 * Filtering is the security control: only names on the allowlist are ever
 * returned, so a partial catalog can only ever yield fewer capabilities, never
 * more. Missing tools are therefore reported rather than thrown — an earlier
 * version treated them as fatal, which bricked every turn whenever MCP
 * discovery had not yet completed.
 */
export function applyToolPolicy(all: ToolSet): ToolPolicyResult {
	// The input is the full gateway catalog, write tools included. That is
	// expected; the point of this function is to not pass them on.
	const tools: ToolSet = {};
	for (const [name, tool] of Object.entries(all)) {
		if (READ_ONLY_ALLOWLIST.has(name)) tools[name] = tool;
	}

	// Defence in depth: only reachable if the allowlist and the write list
	// ever overlap, which would make the filter above a no-op for that tool.
	// That is a genuine policy failure and must stop the turn.
	const leaked = Object.keys(tools).filter((n) => FORBIDDEN.has(n));
	if (leaked.length > 0) {
		throw new ToolPolicyError(
			`Write-capable tools reached the model tool set: ${leaked.join(", ")}`,
		);
	}

	return {
		tools,
		missing: [...READ_ONLY_ALLOWLIST].filter((n) => !(n in tools)),
	};
}
