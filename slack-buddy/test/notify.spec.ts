import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyOwner } from "../src/notify";

const WORKFLOW_URL = "https://hooks.slack.com/triggers/T0000/1111/abcdef";
const LINK = "https://acme.enterprise.slack.com/archives/D0BTQQF7WCW/p1793608223867809";

/** A fetch double that records each request and answers with `respond()`. */
function fakeFetch(respond: () => Response | Promise<Response>) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return respond();
	}) as typeof fetch;
	return { fetcher, calls };
}

describe("notifyOwner", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does nothing without a workflow URL", async () => {
		const { fetcher, calls } = fakeFetch(() => Response.json({ ok: true }));
		expect(await notifyOwner(undefined, "text", LINK, fetcher)).toBe(false);
		expect(await notifyOwner("", "text", LINK, fetcher)).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("posts the text as the workflow's message variable, with the link on its own line", async () => {
		const { fetcher, calls } = fakeFetch(() => Response.json({ ok: true }));
		expect(await notifyOwner(WORKFLOW_URL, "Morning briefing · Mon 9 Nov: 3 items.", LINK, fetcher)).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(WORKFLOW_URL);
		expect(calls[0].init.method).toBe("POST");
		expect(new Headers(calls[0].init.headers).get("Content-Type")).toBe("application/json");
		expect(JSON.parse(String(calls[0].init.body))).toEqual({ message: `Morning briefing · Mon 9 Nov: 3 items.\n${LINK}` });
	});

	it("leaves out a link that is not a Slack permalink", async () => {
		const { fetcher, calls } = fakeFetch(() => Response.json({ ok: true }));
		await notifyOwner(WORKFLOW_URL, "text", "https://evil.example/archives/C1/p1", fetcher);
		await notifyOwner(WORKFLOW_URL, "text", null, fetcher);
		expect(calls.map((c) => JSON.parse(String(c.init.body)).message)).toEqual(["text", "text"]);
	});

	it("reports a refusal or a network failure without throwing, and keeps the URL out of the log", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const refused = fakeFetch(() => new Response('{"ok":false,"error":"invalid_workflow_input"}', { status: 400 }));
		const softRefusal = fakeFetch(() => Response.json({ ok: false, error: "workflow_not_published" }));
		const unreachable = fakeFetch(() => Promise.reject(new TypeError(`fetch failed: ${WORKFLOW_URL}`)));

		expect(await notifyOwner(WORKFLOW_URL, "text", null, refused.fetcher)).toBe(false);
		expect(await notifyOwner(WORKFLOW_URL, "text", null, softRefusal.fetcher)).toBe(false);
		expect(await notifyOwner(WORKFLOW_URL, "text", null, unreachable.fetcher)).toBe(false);

		const logged = log.mock.calls.flat().join("\n");
		expect(logged).toContain("invalid_workflow_input");
		expect(logged).toContain("workflow_not_published");
		expect(logged).not.toContain(WORKFLOW_URL);
	});
});
