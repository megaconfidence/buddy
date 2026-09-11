// Opt-in live benchmark. Prints aggregate metrics only; never saves Slack text.
import { SlackMcp, type ToolResult } from "../src/mcp/client";
import { envelope, pagination } from "../src/mcp/normalize";
import { retrieve } from "../src/mcp/retrieve";
import { DEFAULT_SETTINGS } from "../src/mcp/settings";
import { summarize } from "../src/mcp/model";
import type { Env } from "../src/env";

async function main() {
  if (!process.env.MISTRAL_API_KEY || !process.env.SLACK_USER_ID)
    throw new Error("Missing benchmark credentials");
  const env = process.env as unknown as Env;
  const mcp = new SlackMcp(env.MISTRAL_API_KEY);
  const timings: Array<{
    tool: string;
    milliseconds: number;
    paginationRecognized: boolean;
  }> = [];
  const reader = {
    read: async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      const start = Date.now();
      const r = await mcp.read(name, args);
      const e = envelope(r);
      const p = pagination(e.pagination_info);
      timings.push({
        tool: name,
        milliseconds: Date.now() - start,
        paginationRecognized: !p.partial,
      });
      return r;
    },
  };
  try {
    const end = Date.now();
    const r = await retrieve(
      reader,
      DEFAULT_SETTINGS,
      env.SLACK_USER_ID,
      end - 7 * 86400_000,
      end,
      {
        plan: [
          { label: "OCR", query: "OCR", scope: "joined" },
          { label: "Vibe", query: "Vibe", scope: "joined" },
          { label: "Wider radar", query: "launch", scope: "public" },
        ],
        maxRequests: 4,
      },
    );
    const output: Record<string, unknown> = {
      requests: r.requests,
      matches: r.sources.length,
      elapsedMs: r.elapsedMs,
      partial: r.partial,
      coverage: r.coverage,
      timings,
    };
    if (process.env.SLACK_BUDDY_BENCHMARK_MODEL === "true") {
      const began = Date.now();
      const b = await summarize(
        { ...env, MISTRAL_MODEL: env.MISTRAL_MODEL || "zai-glm-5-2" },
        DEFAULT_SETTINGS,
        r,
      );
      output.modelMs = Date.now() - began;
      output.items = b.items.length;
      output.sections = Object.fromEntries(
        ["attention", "radar", "upcoming", "content"].map((s) => [
          s,
          b.items.filter((i) => i.section === s).length,
        ]),
      );
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await mcp.close();
  }
}
main().catch(() => {
  console.error(
    "MCP benchmark failed; inspect credentials, connector availability, or model configuration.",
  );
  process.exitCode = 1;
});
