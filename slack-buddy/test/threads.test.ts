import { describe, expect, it } from "vitest";
import {
  batchCandidateThreads,
  groupMessagesIntoThreads,
  scoreCandidateThreads,
  type MessageWithDisplay,
} from "../src/domain/threads";

const base: MessageWithDisplay = {
  teamId: "T1",
  channelId: "C1",
  messageTs: "100.000001",
  threadTs: "100.000001",
  eventId: "E1",
  eventTime: 100_000,
  postedAt: 100_000,
  userId: "U1",
  text: "The SDK release has a breaking authentication change.",
  subtype: null,
  editedAt: null,
  deletedAt: null,
  channelName: "developers",
  userName: "Ada",
  isBot: false,
};

describe("Slack thread preparation", () => {
  it("groups replies into chronological threads", () => {
    const reply: MessageWithDisplay = {
      ...base,
      messageTs: "101.000001",
      threadTs: base.messageTs,
      eventId: "E2",
      postedAt: 101_000,
      text: "Developers will need a migration example.",
    };

    const threads = groupMessagesIntoThreads([reply, base]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messages.map((message) => message.messageTs)).toEqual([
      "100.000001",
      "101.000001",
    ]);
  });

  it("always prioritizes direct mentions", () => {
    const mentioned = {
      ...base,
      text: "Could <@UADVOCATE> help with this tutorial?",
    };
    const candidates = scoreCandidateThreads(
      groupMessagesIntoThreads([mentioned]),
      "UADVOCATE",
    );

    expect(candidates[0]?.mustShow).toBe(true);
    expect(candidates[0]?.heuristicScore).toBeGreaterThanOrEqual(100);
  });

  it("drops isolated acknowledgements before model ranking", () => {
    const acknowledgement = { ...base, text: "thanks!" };
    const candidates = scoreCandidateThreads(
      groupMessagesIntoThreads([acknowledgement]),
      "UADVOCATE",
    );
    expect(candidates).toEqual([]);
  });

  it("batches without dropping candidates", () => {
    const candidates = scoreCandidateThreads(
      groupMessagesIntoThreads([
        base,
        {
          ...base,
          channelId: "C2",
          eventId: "E2",
          messageTs: "200.000001",
          threadTs: "200.000001",
        },
      ]),
      "UADVOCATE",
    );
    const batches = batchCandidateThreads(candidates, 150);
    expect(batches.flat()).toHaveLength(candidates.length);
    expect(batches.length).toBeGreaterThan(1);
  });
});
