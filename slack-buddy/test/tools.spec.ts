import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
	READ_ONLY_ALLOWLIST,
	READ_ONLY_TOOLS,
	WRITE_TOOLS,
	ToolPolicyError,
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
		const allowed = applyToolPolicy(fullCatalog());

		expect(Object.keys(allowed)).toHaveLength(12);
		expect(READ_ONLY_ALLOWLIST.size).toBe(12);
	});

	it("never lets a write tool through", () => {
		const allowed = applyToolPolicy(fullCatalog());

		for (const write of WRITE_TOOLS) {
			expect(allowed).not.toHaveProperty(ns(write));
		}
		expect(allowed).not.toHaveProperty(ns("slack_send_message"));
	});

	it("matches namespaced keys, not raw gateway tool names", () => {
		// getAITools() returns `tool_{serverId}_{toolName}`. An allowlist
		// written against raw names would silently match nothing.
		expect(READ_ONLY_ALLOWLIST.has("slack_read_channel")).toBe(false);
		expect(READ_ONLY_ALLOWLIST.has("tool_slack_slack_read_channel")).toBe(true);
	});

	it("fails closed when the catalog is short", () => {
		const partial = toolSetFrom(READ_ONLY_TOOLS.slice(0, 5).map(ns));
		expect(() => applyToolPolicy(partial)).toThrow(ToolPolicyError);
	});

	it("ignores unknown tools rather than adopting them", () => {
		const catalog = {
			...fullCatalog(),
			...toolSetFrom([ns("slack_some_future_tool")]),
		};
		const allowed = applyToolPolicy(catalog);

		expect(Object.keys(allowed)).toHaveLength(12);
		expect(allowed).not.toHaveProperty(ns("slack_some_future_tool"));
	});

	it("keeps read and write sets disjoint and complete", () => {
		const overlap = READ_ONLY_TOOLS.filter((t) =>
			(WRITE_TOOLS as readonly string[]).includes(t),
		);
		expect(overlap).toEqual([]);
		expect(READ_ONLY_TOOLS.length + WRITE_TOOLS.length).toBe(19);
	});
});
