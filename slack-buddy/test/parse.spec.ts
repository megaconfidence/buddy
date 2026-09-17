import { describe, expect, it } from "vitest";
import {
	parseConversation,
	parseSearchResults,
	permalinkMatches,
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
