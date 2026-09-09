import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel } from "ai";
import { rankThreads, synthesizeDigest } from "../src/ai/model";
import { DEFAULT_PROFILE } from "../src/domain/profile";
import type { RankedDigestItem } from "../src/domain/types";
import { digest, item } from "./helpers/fixtures";

vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const model = {} as LanguageModel;

function mockSynthesis(
  transform: (items: RankedDigestItem[]) => RankedDigestItem[],
) {
  vi.mocked(generateText).mockImplementation(async (options) => {
    const items = JSON.parse(
      String(options.prompt).split("RANKED_ITEMS\n")[1]!,
    ) as RankedDigestItem[];
    return { output: digest(transform(items)) } as Awaited<
      ReturnType<typeof generateText>
    >;
  });
}

describe("grounded digest selection", () => {
  it("replaces colliding batch IDs before synthesis without exchanging sources", async () => {
    mockSynthesis((items) => items);
    const result = await synthesizeDigest(
      model,
      DEFAULT_PROFILE,
      [item("C1"), item("C2")],
      2,
    );
    expect(new Set(result.items.map((i) => i.id)).size).toBe(2);
    for (const resultItem of result.items) {
      expect(resultItem.headline).toBe(
        `Announcement in ${resultItem.sources[0]?.channelId}`,
      );
    }
    const repeated = await synthesizeDigest(
      model,
      DEFAULT_PROFILE,
      [item("C1"), item("C2")],
      2,
    );
    expect(repeated.items.map((i) => i.id)).toEqual(
      result.items.map((i) => i.id),
    );
  });

  it("preserves all required items, including more than fifteen and downgraded outputs", async () => {
    mockSynthesis((items) => [
      ...items.filter((i) => !i.mustShow),
      ...items
        .filter((i) => i.mustShow)
        .slice(0, 1)
        .map((i) => ({
          ...i,
          category: "borderline" as const,
          urgency: "fyi" as const,
          actionRequired: false,
          summary: "Changed",
        })),
    ]);
    const required = Array.from({ length: 20 }, (_, i) =>
      item(`R${i}`, {
        mustShow: true,
        relevance: 100,
        category: "needs_attention",
        urgency: "today",
        actionRequired: true,
      }),
    );
    const result = await synthesizeDigest(
      model,
      DEFAULT_PROFILE,
      [item(), ...required],
      21,
    );
    expect(result.items).toHaveLength(20);
    expect(
      result.items.every(
        (i) =>
          i.mustShow &&
          i.category === "needs_attention" &&
          i.urgency === "today" &&
          i.actionRequired,
      ),
    ).toBe(true);
    expect(result.items.every((i) => i.summary !== "Changed")).toBe(true);
    expect(result.omittedThreadCount).toBe(1);
  });

  it("deduplicates repeated IDs from synthesis and counts distinct represented threads", async () => {
    mockSynthesis((items) => [items[0]!, items[0]!]);
    const result = await synthesizeDigest(
      model,
      DEFAULT_PROFILE,
      [item("C1", { sources: [...item("C1").sources, ...item("C2").sources] })],
      3,
    );
    expect(result.items).toHaveLength(1);
    expect(result.omittedThreadCount).toBe(1);
  });

  it("assigns stable application IDs to ranking output and fills omitted mentions", async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { items: [] },
    } as unknown as Awaited<ReturnType<typeof generateText>>);
    const candidates = [
      {
        mustShow: true,
        heuristicScore: 100,
        thread: {
          id: "T1:C1:100",
          teamId: "T1",
          channelId: "C1",
          channelName: "dev",
          threadTs: "100",
          startedAt: 100000,
          latestAt: 100000,
          messages: [
            {
              messageTs: "100",
              userId: "U1",
              userName: "Ada",
              text: "<@UOWNER> help",
              postedAt: 100000,
            },
          ],
        },
      },
    ];
    const result = await rankThreads(model, DEFAULT_PROFILE, candidates);
    expect(result[0]).toMatchObject({ mustShow: true, relevance: 100 });
    expect(result[0]?.id).toMatch(/^item-[a-f0-9]{64}$/);
  });
});
