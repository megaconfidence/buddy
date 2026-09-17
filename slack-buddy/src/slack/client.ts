import { MCP_SERVER_ID } from "./tools";
import {
	parseConversation,
	parseReactions,
	parseSearchResults,
	type Reaction,
	type SearchHit,
	type SlackMessage,
} from "./parse";

/**
 * Structural type for the Agents MCP client manager.
 *
 * Declared here rather than imported so the client does not depend on an
 * internal export path of the SDK.
 */
export type McpCaller = {
	callTool(
		params: {
			name: string;
			arguments?: Record<string, unknown>;
			serverId: string;
		},
		options?: unknown,
	): Promise<unknown>;
};

export class SlackGatewayError extends Error {}

type CallResult = {
	isError?: boolean;
	content?: Array<{ type?: string; text?: string }>;
};

/**
 * Typed wrapper over the connectors gateway.
 *
 * Every write method on this class is reachable only from application code.
 * The model never receives these as tools, and the destination channel is
 * supplied by the caller rather than by anything the model produced.
 */
export class SlackClient {
	constructor(private readonly mcp: McpCaller) {}

	private async call(
		name: string,
		args: Record<string, unknown>,
	): Promise<string> {
		const result = (await this.mcp.callTool({
			name,
			arguments: args,
			serverId: MCP_SERVER_ID,
		})) as CallResult;

		const text = result?.content?.find((c) => c.type === "text")?.text ?? "";

		if (result?.isError) {
			throw new SlackGatewayError(`${name} failed: ${text.slice(0, 400)}`);
		}
		return text;
	}

	/** Gateway payloads are a JSON envelope whose fields hold rendered text. */
	private async callField(
		name: string,
		args: Record<string, unknown>,
		field: string,
	): Promise<string> {
		const raw = await this.call(name, args);
		try {
			const envelope = JSON.parse(raw) as Record<string, unknown>;
			const value = envelope[field];
			return typeof value === "string" ? value : raw;
		} catch {
			return raw;
		}
	}

	// ---------------------------------------------------------------- reads

	async readChannel(
		channelId: string,
		opts: { oldest?: string; limit?: number } = {},
	): Promise<SlackMessage[]> {
		const text = await this.callField(
			"slack_read_channel",
			{
				channel_id: channelId,
				...(opts.oldest ? { oldest: opts.oldest } : {}),
				limit: opts.limit ?? 20,
			},
			"messages",
		);
		return parseConversation(text);
	}

	async readThread(
		channelId: string,
		messageTs: string,
		opts: { oldest?: string; limit?: number } = {},
	): Promise<SlackMessage[]> {
		const text = await this.callField(
			"slack_read_thread",
			{
				channel_id: channelId,
				message_ts: messageTs,
				...(opts.oldest ? { oldest: opts.oldest } : {}),
				limit: opts.limit ?? 50,
			},
			"messages",
		);
		return parseConversation(text);
	}

	/**
	 * Search the channels the owner has joined.
	 *
	 * `channel_types` is always passed explicitly. The gateway default includes
	 * `im,mpim`, which would pull direct messages into the sweep.
	 */
	async searchJoined(opts: {
		keywords: string[];
		naturalLanguageQuery?: string;
		after?: string;
		before?: string;
		limit?: number;
		includeContext?: boolean;
	}): Promise<SearchHit[]> {
		const text = await this.callField(
			"slack_search_public_and_private",
			{
				query: opts.keywords.join(" "),
				keywords: opts.keywords,
				natural_language_query: opts.naturalLanguageQuery ?? "",
				only_my_channels: true,
				channel_types: "public_channel,private_channel",
				sort: "timestamp",
				sort_dir: "desc",
				limit: opts.limit ?? 20,
				include_context: opts.includeContext ?? true,
				...(opts.after ? { after: opts.after } : {}),
				...(opts.before ? { before: opts.before } : {}),
			},
			"results",
		);
		return parseSearchResults(text);
	}

	async getReactions(
		channelId: string,
		messageTs: string,
	): Promise<Reaction[]> {
		const text = await this.callField(
			"slack_get_reactions",
			{ channel_id: channelId, message_ts: messageTs },
			"result",
		);
		return parseReactions(text);
	}

	// --------------------------------------------------------------- writes

	/**
	 * Send a message. Returns the timestamp so the caller can record it in the
	 * sent ledger before advancing any cursor.
	 */
	async sendMessage(opts: {
		channelId: string;
		text: string;
		threadTs?: string;
	}): Promise<{ ts: string; permalink: string | null }> {
		const raw = await this.call("slack_send_message", {
			channel_id: opts.channelId,
			message: opts.text,
			...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
		});

		let ts: string | undefined;
		let permalink: string | null = null;
		try {
			const parsed = JSON.parse(raw) as {
				message_link?: string;
				message_context?: { message_ts?: string };
			};
			ts = parsed.message_context?.message_ts;
			permalink = parsed.message_link ?? null;
		} catch {
			// fall through to the error below
		}

		if (!ts) {
			throw new SlackGatewayError(
				`slack_send_message returned no message_ts: ${raw.slice(0, 200)}`,
			);
		}
		return { ts, permalink };
	}

	async addReaction(
		channelId: string,
		messageTs: string,
		emoji: string,
	): Promise<void> {
		await this.call("slack_add_reaction", {
			channel_id: channelId,
			message_ts: messageTs,
			emoji,
		});
	}
}
