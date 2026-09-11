import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const MCP_ENDPOINT =
  "https://api.mistral.ai/v1/connectors-gateway/slack/mcp";
const READ_TOOLS = new Set([
  "slack_search_public",
  "slack_search_public_and_private",
  "slack_search_channels",
  "slack_read_thread",
  "slack_read_channel",
]);
export type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};
export interface SlackReader {
  read(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}
export class McpFailure extends Error {
  constructor(
    public code:
      | "authentication"
      | "rate_limit"
      | "timeout"
      | "tool_error"
      | "format"
      | "budget",
  ) {
    super(code);
  }
}
export class SlackMcp implements SlackReader {
  private client = new Client({ name: "slack-buddy", version: "2.0.0" });
  private connected = false;
  private connection?: Promise<void>;
  constructor(private key: string) {}
  private connect() {
    this.connection ??= this.client
      .connect(
        new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT), {
          requestInit: {
            headers: { Authorization: `Bearer ${this.key}` },
            redirect: "error",
          },
          fetch: async (url, init) => {
            const response = await fetch(url, {
              ...init,
              signal: AbortSignal.any([
                ...(init?.signal ? [init.signal] : []),
                AbortSignal.timeout(20_000),
              ]),
            });
            if (response.status === 401 || response.status === 403)
              throw new McpFailure("authentication");
            if (response.status === 429) throw new McpFailure("rate_limit");
            return response;
          },
        }),
        { timeout: 25_000 },
      )
      .then(() => {
        this.connected = true;
      });
    return this.connection;
  }
  async read(name: string, args: Record<string, unknown>) {
    if (!READ_TOOLS.has(name)) throw new McpFailure("tool_error");
    return this.call(name, args);
  }
  // Writes are never exposed to the model or the retrieval planner.
  async send(owner: string, message: string) {
    return this.call("slack_send_message", { channel_id: owner, message });
  }
  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      await this.connect();
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 25_000 },
      );
      if (result.isError) {
        const text = JSON.stringify(result);
        if (/ratelimit|rate.limit|too many requests/i.test(text))
          throw new McpFailure("rate_limit");
        if (
          /token_revoked|invalid_auth|not_authed|unauthorized|missing_scope/i.test(
            text,
          )
        )
          throw new McpFailure("authentication");
        throw new McpFailure("tool_error");
      }
      return result as ToolResult;
    } catch (error) {
      if (error instanceof McpFailure) throw error;
      // Never propagate connector errors that may contain source text or headers.
      throw new McpFailure(
        /timeout|timed out|abort/i.test(String(error))
          ? "timeout"
          : "tool_error",
      );
    }
  }
  async close() {
    if (this.connected) await this.client.close().catch(() => {});
  }
}
