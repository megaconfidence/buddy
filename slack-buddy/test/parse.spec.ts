import { describe, expect, it } from "vitest";
import {
	buildPermalink,
	cleanAuthorName,
	isSlackPermalink,
	parseConversation,
	parseSearchEnvelope,
	parseSearchResults,
	parseSlackLocalTime,
	permalinkMatches,
	workspaceHostOf,
} from "../src/slack/parse";

/**
 * Fixtures are verbatim gateway output captured on 2026-09-17, including the
 * trailing space after `===` and the two different timestamp spellings.
 */

const CHANNEL_READ = `Channel: DM (D0BTQQF7WCW)

=== Message from Confidence Okoghenun <confidence.okoghenun@mistral.ai> (U0BUM44636U) at 2026-09-17 20:46:53 BST === 
Message TS: 1789674413.379719
slack-buddy setup check — verifying the send response shape. Safe to delete.
*Sent using* <@U0B66544P62|Vibe>
Thread: 1 replies (latest: 2026-09-17 20:47:14 BST)
`;

const THREAD_READ = `=== THREAD PARENT MESSAGE ===
From: Confidence Okoghenun <confidence.okoghenun@mistral.ai> (U0BUM44636U)
Time: 2026-09-17 20:46:53 BST
Message TS: 1789674413.379719
slack-buddy setup check — verifying the send response shape. Safe to delete.
*Sent using* <@U0B66544P62|Vibe>

=== THREAD REPLIES (1 total) ===

--- Reply 1 of 1 ---
From: Confidence Okoghenun <confidence.okoghenun@mistral.ai> (U0BUM44636U)
Time: 2026-09-17 20:47:14 BST
Message TS: 1789674434.430189
threaded reply — loop-guard check
*Sent using* <@U0B66544P62|Vibe>
`;

const SEARCH = `# Search Results for: mistral

## Messages (2 results)
### Result 1 of 2
Channel: #it (ID: C083YJ8348H)
From:  (ID: U00)  [BOT]
Time: 2026-09-17 20:18:20 BST
Message_ts: 1789672700.289059
Permalink: [link](https://mistralai.slack.com/archives/C083YJ8348H/p1789672700289059?thread_ts=1789486066.556089&cid=C083YJ8348H)
Text: 
Mistral-defense Group has been set on the Wiz Google SAML settings.
Context before: 
- From: Léonard de La Seiglière <leonard@mistral.ai> (ID: U08PVHNTREZ) 
  Message_ts: 1789658341.055729
  Thanks a lot!

---

### Result 2 of 2
Channel: #ext-joyco-mistral-videos (ID: C0ABBL271GF)
From: Lucero Olveira <krimson@joyco.studio> (ID: U07EY99S0Q6) 
Time: 2026-09-17 20:16:47 BST
Message_ts: 1789672607.805969
Permalink: [link](https://mistralai.slack.com/archives/C0ABBL271GF/p1789672607805969)
Text: 
Hey Mistral team, sharing some clips for the AI Engineer Paris intro screens.
`;

describe("parseConversation", () => {
	it("parses a channel read and keeps the thread signature intact", () => {
		const [message] = parseConversation(CHANNEL_READ);

		expect(message.ts).toBe("1789674413.379719");
		expect(message.authorId).toBe("U0BUM44636U");
		expect(message.sentViaApp).toBe(true);
		expect(message.threadReplyCount).toBe(1);
		// Kept as an opaque string: it is a local datetime, not a timestamp.
		expect(message.threadLatest).toBe("2026-09-17 20:47:14 BST");
		expect(message.text).toContain("verifying the send response shape");
		expect(message.text).not.toContain("Sent using");
		expect(message.text).not.toContain("Thread:");
	});

	it("drops the channel preamble rather than treating it as a body", () => {
		const messages = parseConversation(CHANNEL_READ);
		expect(messages).toHaveLength(1);
		expect(messages[0].text).not.toContain("Channel: DM");
	});

	it("parses a thread into parent plus replies", () => {
		const messages = parseConversation(THREAD_READ);

		expect(messages.map((m) => m.ts)).toEqual([
			"1789674413.379719",
			"1789674434.430189",
		]);
		expect(messages[1].text).toBe("threaded reply — loop-guard check");
	});

	it("gives both thread participants the same author id", () => {
		// This is why threading alone cannot guard the loop and the sent
		// ledger is required. Regression test for a real design defect.
		const messages = parseConversation(THREAD_READ);
		expect(new Set(messages.map((m) => m.authorId))).toEqual(
			new Set(["U0BUM44636U"]),
		);
	});
});

describe("parseSearchResults", () => {
	it("extracts one record per result", () => {
		const hits = parseSearchResults(SEARCH);
		expect(hits).toHaveLength(2);
		expect(hits[0].ts).toBe("1789672700.289059");
		expect(hits[0].channelId).toBe("C083YJ8348H");
		expect(hits[0].channelName).toBe("#it");
		expect(hits[1].authorId).toBe("U07EY99S0Q6");
		expect(hits[1].authorName).toBe("Lucero Olveira <krimson@joyco.studio>");
	});

	it("does not mistake a context timestamp for the record timestamp", () => {
		const hits = parseSearchResults(SEARCH);
		expect(hits[0].ts).not.toBe("1789658341.055729");
	});

	it("stops the body at the context block", () => {
		const hits = parseSearchResults(SEARCH);
		expect(hits[0].text).toBe(
			"Mistral-defense Group has been set on the Wiz Google SAML settings.",
		);
		expect(hits[0].text).not.toContain("Thanks a lot");
	});

	it("tolerates an empty author name", () => {
		const hits = parseSearchResults(SEARCH);
		expect(hits[0].authorId).toBe("U00");
		expect(hits[0].authorName).toBeNull();
	});

	it("reads the bot marker", () => {
		const hits = parseSearchResults(SEARCH);
		expect(hits[0].isBot).toBe(true);
		expect(hits[1].isBot).toBe(false);
	});

	it("keeps the context as readable lines, without ids or emails", () => {
		const hits = parseSearchResults(SEARCH);
		expect(hits[0].context).toBe("Léonard de La Seiglière: Thanks a lot!");
		expect(hits[1].context).toBe("");
	});
});

describe("parseSearchEnvelope", () => {
	it("splits the rendered results from a cursor in the envelope", () => {
		const raw = JSON.stringify({ results: SEARCH, response_metadata: { next_cursor: "Q1VSUkVOVF9QQUdFOjI=" } });
		const { results, nextCursor } = parseSearchEnvelope(raw);
		expect(parseSearchResults(results)).toHaveLength(2);
		expect(nextCursor).toBe("Q1VSUkVOVF9QQUdFOjI=");
	});

	it("reads the cursor from pagination_info, as the gateway actually sends it", () => {
		// Shape observed live on 2026-11-01; the cursor value is illustrative.
		const raw = JSON.stringify({
			results: SEARCH,
			pagination_info: "For the next page of results use cursor `Q1VSUkVOVF9QQUdFOjI=`",
		});
		expect(parseSearchEnvelope(raw).nextCursor).toBe("Q1VSUkVOVF9QQUdFOjI=");
	});

	it("returns no cursor when pagination_info says there is nothing more", () => {
		const raw = JSON.stringify({ results: SEARCH, pagination_info: "There are no more messages available." });
		expect(parseSearchEnvelope(raw).nextCursor).toBeNull();
	});

	it("finds a cursor rendered as text", () => {
		const raw = JSON.stringify({ results: SEARCH, pagination_info: "Next cursor: Q1VSUkVOVF9QQUdFOjI=" });
		expect(parseSearchEnvelope(raw).nextCursor).toBe("Q1VSUkVOVF9QQUdFOjI=");
	});

	it("does not mistake a message body for a cursor", () => {
		const body = SEARCH.replace("Thanks a lot!", "the next cursor: abcdefgh is in the doc");
		expect(parseSearchEnvelope(JSON.stringify({ results: body })).nextCursor).toBeNull();
	});

	it("returns no cursor on the last page", () => {
		expect(parseSearchEnvelope(JSON.stringify({ results: SEARCH })).nextCursor).toBeNull();
	});

	it("accepts a payload that is not JSON", () => {
		const { results, nextCursor } = parseSearchEnvelope(SEARCH);
		expect(results).toBe(SEARCH);
		expect(nextCursor).toBeNull();
	});
});

describe("parseSlackLocalTime", () => {
	it("parses the gateway's rendered times with their zone", () => {
		expect(parseSlackLocalTime("2026-09-17 20:47:14 BST")).toBe(Date.UTC(2026, 8, 17, 19, 47, 14));
		expect(parseSlackLocalTime("2026-12-01 09:00:00 GMT")).toBe(Date.UTC(2026, 11, 1, 9, 0, 0));
		expect(parseSlackLocalTime("2026-12-01 09:00:00 +01:00")).toBe(Date.UTC(2026, 11, 1, 8, 0, 0));
	});

	it("refuses to guess an unknown or missing zone", () => {
		expect(parseSlackLocalTime("2026-09-17 20:47:14 IST")).toBeNull();
		expect(parseSlackLocalTime("2026-09-17 20:47:14")).toBeNull();
		expect(parseSlackLocalTime(null)).toBeNull();
	});
});

describe("cleanAuthorName", () => {
	it("drops the email", () => {
		expect(cleanAuthorName("Lucero Olveira <krimson@joyco.studio>")).toBe("Lucero Olveira");
		expect(cleanAuthorName("")).toBeNull();
	});
});

describe("buildPermalink", () => {
	it("builds a link from known ids", () => {
		expect(buildPermalink("mistralai.slack.com", "C083YJ8348H", "1789672700.289059")).toBe(
			"https://mistralai.slack.com/archives/C083YJ8348H/p1789672700289059",
		);
	});

	it("refuses anything that is not a Slack workspace or a real id", () => {
		expect(buildPermalink("evil.example", "C083YJ8348H", "1789672700.289059")).toBeNull();
		expect(buildPermalink(null, "C083YJ8348H", "1789672700.289059")).toBeNull();
		expect(buildPermalink("mistralai.slack.com", "C08/../x", "1789672700.289059")).toBeNull();
	});

	it("learns the host from a permalink", () => {
		expect(workspaceHostOf("https://mistralai.slack.com/archives/C1/p1")).toBe("mistralai.slack.com");
		expect(workspaceHostOf("https://evil.example/archives/C1/p1")).toBeNull();
	});

	it("supports Enterprise Grid hosts, which have an extra label", () => {
		// Regression: a one-label host pattern rejected every live permalink.
		const host = "acme.enterprise.slack.com";
		expect(workspaceHostOf(`https://${host}/archives/C083YJ8348H/p1789672700289059?thread_ts=1789486066.556089&cid=C083YJ8348H`)).toBe(host);
		expect(buildPermalink(host, "C083YJ8348H", "1789672700.289059")).toBe(`https://${host}/archives/C083YJ8348H/p1789672700289059`);
	});
});

describe("isSlackPermalink", () => {
	it("accepts plain and Enterprise Grid permalinks, with thread parameters", () => {
		expect(isSlackPermalink("https://mistralai.slack.com/archives/C083YJ8348H/p1789672700289059")).toBe(true);
		expect(
			isSlackPermalink(
				"https://acme.enterprise.slack.com/archives/C083YJ8348H/p1789672700289059?thread_ts=1789486066.556089&cid=C083YJ8348H",
			),
		).toBe(true);
	});

	it("rejects anything else", () => {
		expect(isSlackPermalink("https://slack.com.evil.example/archives/C1/p1")).toBe(false);
		expect(isSlackPermalink("http://acme.slack.com/archives/C1/p1")).toBe(false);
		expect(isSlackPermalink("https://acme.slack.com/archives/C1/p1)[x](https://evil.example")).toBe(false);
		expect(isSlackPermalink("https://acme.slack.com/messages/C1")).toBe(false);
		expect(isSlackPermalink(null)).toBe(false);
	});
});

describe("permalinkMatches", () => {
	const link =
		"https://mistralai.slack.com/archives/C083YJ8348H/p1789672700289059?thread_ts=1789486066.556089&cid=C083YJ8348H";

	it("accepts a link matching its own channel and timestamp", () => {
		expect(permalinkMatches(link, "C083YJ8348H", "1789672700.289059")).toBe(true);
	});

	it("rejects a link pointing at another channel", () => {
		expect(permalinkMatches(link, "C0ABBL271GF", "1789672700.289059")).toBe(false);
	});

	it("rejects a link pointing at another message", () => {
		expect(permalinkMatches(link, "C083YJ8348H", "1789672607.805969")).toBe(false);
	});

	it("rejects a missing link", () => {
		expect(permalinkMatches(null, "C083YJ8348H", "1789672700.289059")).toBe(false);
	});
});
