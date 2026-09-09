import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackBuddyAgent } from "../src/agent";
import { SlackBuddyRepository } from "../src/storage/repository";
import type { Env } from "../src/env";
import { testDatabase } from "./helpers/database";
import { digest, item, window } from "./helpers/fixtures";

vi.mock("@cloudflare/think", () => ({
  Think: class {
    private config: unknown = null;
    constructor(
      _ctx: unknown,
      public env: Env,
    ) {}
    configure(config: unknown) {
      this.config = structuredClone(config);
    }
    getConfig() {
      return this.config;
    }
  },
}));

let database: ReturnType<typeof testDatabase>;
let agent: SlackBuddyAgent;
beforeEach(async () => {
  database = testDatabase();
  const repository = new SlackBuddyRepository(database.db);
  for (const [index, id] of ["C1", "C2"].entries()) {
    await repository.createDigestRun({
      id,
      teamId: "T1",
      userId: "U1",
      window: { ...window, localDate: `2026-09-0${index + 1}` },
    });
    await repository.saveDigest({
      digestId: id,
      digest: digest([item(id)]),
      markdown: "",
      model: "test",
      promptVersion: "test",
      inputMessageCount: 1,
    });
  }
  agent = new SlackBuddyAgent(
    {} as DurableObjectState,
    { DB: database.db } as Env,
  );
  await agent.configureForUser({ teamId: "T1", userId: "U1" });
});
afterEach(() => {
  database.close();
  vi.restoreAllMocks();
});
const feedback = (id: string) => ({
  feedbackId: id,
  teamId: "T1",
  userId: "U1",
  digestId: id,
  itemId: "item-1",
  value: "relevant" as const,
});

describe("profile mutations", () => {
  it("keeps both overlapping feedback updates and distinct audit versions", async () => {
    await Promise.all([
      agent.applyFeedback(feedback("C1")),
      agent.applyFeedback(feedback("C2")),
    ]);
    const profile = await agent.getRelevanceProfile();
    expect(profile.positiveExamples).toHaveLength(2);
    expect(profile.version).toBe(3);
    const versions = database.sqlite
      .prepare(
        "SELECT version, profile_json FROM profile_versions ORDER BY version",
      )
      .all();
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(JSON.parse(String(versions[2]?.profile_json))).toEqual(profile);
  });

  it("keeps explicit preference updates while feedback is waiting on I/O", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = SlackBuddyRepository.prototype.getStoredDigest;
    vi.spyOn(
      SlackBuddyRepository.prototype,
      "getStoredDigest",
    ).mockImplementation(async function (this: SlackBuddyRepository, id) {
      await gate;
      return original.call(this, id);
    });
    const pending = agent.applyFeedback(feedback("C1"));
    const execute = agent.getTools().update_relevance_profile.execute!;
    await execute(
      { currentPriorities: ["SDK launch"] },
      { toolCallId: "test", messages: [], context: {} },
    );
    release();
    await pending;
    expect(await agent.getRelevanceProfile()).toMatchObject({
      currentPriorities: ["SDK launch"],
      version: 3,
    });
    expect((await agent.getRelevanceProfile()).positiveExamples).toHaveLength(
      1,
    );
  });
});
