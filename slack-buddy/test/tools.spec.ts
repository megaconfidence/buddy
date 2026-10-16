import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
	READ_ONLY_ALLOWLIST,
	READ_ONLY_TOOLS,
	WRITE_TOOLS,
	applyToolPolicy,
} from "../src/slack/tools";

/**
 * The tool policy is the security boundary of this design. Think's
 * `includeMcpTools` defaults to true, so without it the model would receive
 * every gateway tool — including sends that run under a user token with
 * workspace-wide reach.
 */

const stub = () => ({ description: "", inputSchema: {}, execute: async () => ({}) });

const toolSetFrom = (names: string[]): ToolSet =>
	Object.fromEntries(names.map((n) => [n, stub()])) as unknown as ToolSet;

const ns = (name: string) => `tool_slack_${name}`;

const fullCatalog = () => toolSetFrom([...READ_ONLY_TOOLS, ...WRITE_TOOLS].map(ns));

describe("applyToolPolicy", () => {
	it("reduces the full 19-tool catalog to the 12 read-only tools", () => {
		const { tools, missing } = applyToolPolicy(fullCatalog());

		expect(Object.keys(tools)).toHaveLength(12);
		expect(missing).toEqual([]);
		expect(READ_ONLY_ALLOWLIST.size).toBe(12);
	});

	it("never lets a write tool through", () => {
		const { tools } = applyToolPolicy(fullCatalog());

		for (const write of WRITE_TOOLS) {
			expect(tools).not.toHaveProperty(ns(write));
		}
		expect(tools).not.toHaveProperty(ns("slack_send_message"));
	});

	it("matches namespaced keys, not raw gateway tool names", () => {
		// getAITools() returns `tool_{serverId}_{toolName}`. An allowlist
		// written against raw names would silently match nothing.
		expect(READ_ONLY_ALLOWLIST.has("slack_read_channel")).toBe(false);
		expect(READ_ONLY_ALLOWLIST.has("tool_slack_slack_read_channel")).toBe(true);
	});

	it("degrades instead of throwing when discovery has not finished", () => {
		// MCP connections are restored asynchronously, so a partial catalog is
		// normal on a cold start. Treating it as fatal bricked every turn in
		// the first deployment; this is the regression test for that.
		const partial = toolSetFrom(READ_ONLY_TOOLS.slice(0, 5).map(ns));
		const { tools, missing } = applyToolPolicy(partial);

		expect(Object.keys(tools)).toHaveLength(5);
		expect(missing).toHaveLength(7);
	});

	it("reports an empty catalog as fully missing, not as an error", () => {
		const { tools, missing } = applyToolPolicy({});
		expect(Object.keys(tools)).toHaveLength(0);
		expect(missing).toHaveLength(12);
	});

	it("ignores unknown tools rather than adopting them", () => {
		const catalog = {
			...fullCatalog(),
			...toolSetFrom([ns("slack_some_future_tool")]),
		};
		const { tools } = applyToolPolicy(catalog);

		expect(Object.keys(tools)).toHaveLength(12);
		expect(tools).not.toHaveProperty(ns("slack_some_future_tool"));
	});

	it("keeps read and write sets disjoint and complete", () => {
		const overlap = READ_ONLY_TOOLS.filter((t) =>
			(WRITE_TOOLS as readonly string[]).includes(t),
		);
		expect(overlap).toEqual([]);
		expect(READ_ONLY_TOOLS.length + WRITE_TOOLS.length).toBe(19);
	});
});
