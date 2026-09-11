import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("does not write unchanged directory data or duplicate source messages", async () => {
    const db = testDatabase();
    databases.push(db);
    const repo = new SlackBuddyRepository(db.db);
    const channel = {
      teamId: "T1",
      channelId: "C1",
      name: "dev",
      isPrivate: false,
      isArchived: false,
    };
    const user = {
      teamId: "T1",
      userId: "U1",
      displayName: "Owner",
      realName: "Owner Name",
      isBot: false,
    };
    const source = message({ eventId: "history:T1:C1:source" });
    await repo.upsertChannel(channel);
    await repo.upsertUser(user);
    await repo.ingestMessage(source);
    const changes = () =>
      db.sqlite.prepare("SELECT total_changes() AS n").get()!.n;
    const before = changes();
    await repo.upsertChannels([channel]);
    await repo.upsertUsers([user]);
    await repo.touchChannel({ teamId: "T1", channelId: "C1", name: "dev" });
    await repo.ingestMessage(source);
    expect(changes()).toBe(before);
    expect(db.sqlite.prepare("SELECT * FROM slack_events").all()).toHaveLength(
      0,
    );
    await repo.upsertChannel({ ...channel, name: "renamed" });
    await repo.upsertUser({ ...user, displayName: "New name" });
    expect(
      db.sqlite.prepare("SELECT name FROM slack_channels").get()!.name,
    ).toBe("renamed");
    expect(
      db.sqlite.prepare("SELECT display_name FROM slack_users").get()!
        .display_name,
    ).toBe("New name");
    await repo.ingestMessage({
      ...source,
      text: "edited",
      eventTime: source.eventTime + 10,
      editedAt: source.eventTime + 10,
    });
    await repo.ingestMessage(source);
    expect(
      db.sqlite.prepare("SELECT text FROM slack_messages").get()!.text,
    ).toBe("edited");
  });

  it("loads only the ranking batch's threads while retaining their earlier context", async () => {
    const repo = repository();
    const parent = message({
      postedAt: window.startMs - 1000,
      messageTs: timestamp(window.startMs - 1000),
    });
    parent.threadTs = parent.messageTs;
    await repo.ingestMessages([
      parent,
      message({ threadTs: parent.threadTs }),
      message({ channelId: "C2" }),
    ]);
    const selected = await repo.loadMessages(
      "T1",
      window.startMs,
      window.endMs,
      [`T1:C1:${parent.threadTs}`],
    );
    expect(selected).toHaveLength(2);
    expect(selected.every((m) => m.channelId === "C1")).toBe(true);
    expect(
      await repo.loadMessages("T1", window.startMs, window.endMs, []),
    ).toEqual([]);
  });

  it("looks up ranking messages by thread instead of scanning all retained team messages", async () => {
    const db = testDatabase();
    databases.push(db);
    const repo = new SlackBuddyRepository(db.db);
    const prepare = vi.spyOn(db.db, "prepare");
    await repo.loadMessages("T1", window.startMs, window.endMs, [
      "T1:C1:1.000001",
    ]);
    const sql = prepare.mock.calls[0]![0];
    const plan = db.sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(
        JSON.stringify([{ channelId: "C1", threadTs: "1.000001" }]),
        "T1",
        window.endMs,
        window.startMs,
        window.endMs,
      );
    expect(plan.map((row) => row.detail).join("\n")).toMatch(
      /SEARCH m USING INDEX idx_slack_messages_thread \(team_id=\? AND channel_id=\? AND thread_ts=\?/,
    );
  });
});
