import { afterEach, describe, expect, it } from "vitest";
import { SlackBuddyRepository } from "../src/storage/repository";
import {
  groupMessagesIntoThreads,
  scoreCandidateThreads,
} from "../src/domain/threads";
import { testDatabase } from "./helpers/database";
import { message, timestamp, window } from "./helpers/fixtures";

const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function repository() {
  const database = testDatabase();
  databases.push(database);
  return new SlackBuddyRepository(database.db);
}

describe("repository thread context and run state", () => {
  it("loads earlier context only for threads active in the digest window", async () => {
    const repo = repository();
    const parent = message({
      messageTs: timestamp(window.startMs - 86_400_000),
      postedAt: window.startMs - 86_400_000,
      text: "<@UOWNER> old question",
    });
    parent.threadTs = parent.messageTs;
    const reply = message({ threadTs: parent.threadTs });
    await repo.ingestMessages([
      parent,
      reply,
      message({ channelId: "C2", postedAt: window.startMs - 1 }),
      message({
        messageTs: timestamp(window.endMs + 1_000),
        threadTs: parent.threadTs,
        postedAt: window.endMs + 1_000,
      }),
      message({ channelId: "C3", deletedAt: window.startMs + 1 }),
    ]);
    const loaded = await repo.loadMessages("T1", window.startMs, window.endMs);
    expect(loaded.map((m) => m.messageTs)).toEqual([
      parent.messageTs,
      reply.messageTs,
    ]);
    expect(
      scoreCandidateThreads(
        groupMessagesIntoThreads(loaded),
        "UOWNER",
        window,
      )[0]?.mustShow,
    ).toBe(false);
  });

  it("does not let scheduler attachment overwrite a completed delivery", async () => {
    const repo = repository();
    await repo.createDigestRun({
      id: "digest",
      teamId: "T1",
      userId: "U1",
      window,
    });
    await repo.recordDigestDelivery({
      digestId: "digest",
      channelId: "D1",
      messageTs: "10.000001",
    });
    await repo.attachWorkflow("digest", "digest");
    expect((await repo.getDigestRun("digest"))?.status).toBe("completed");
    expect(await repo.listIncompleteDigestRuns("T1", "U1")).toEqual([]);
  });
});
