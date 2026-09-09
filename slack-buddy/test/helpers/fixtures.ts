import type {
  RankedDigestItem,
  SlackMessage,
  StructuredDigest,
} from "../../src/domain/types";

export const now = Date.parse("2026-09-09T10:00:00Z");
export const window = {
  localDate: "2026-09-08",
  timezone: "Europe/Paris",
  startMs: Date.parse("2026-09-07T22:00:00Z"),
  endMs: Date.parse("2026-09-08T22:00:00Z"),
};
export const timestamp = (ms: number) => (ms / 1_000).toFixed(6);
export function message(overrides: Partial<SlackMessage> = {}): SlackMessage {
  const ts = timestamp(window.startMs + 3_600_000);
  return {
    teamId: "T1",
    channelId: "C1",
    messageTs: ts,
    threadTs: ts,
    eventId: `event:${ts}`,
    eventTime: Number(ts) * 1_000,
    postedAt: Number(ts) * 1_000,
    userId: "U1",
    text: "An SDK release",
    subtype: null,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}
export function item(
  channelId = "C1",
  overrides: Partial<RankedDigestItem> = {},
): RankedDigestItem {
  return {
    id: "item-1",
    relevance: 80,
    mustShow: false,
    category: "developer_signal",
    urgency: "this_week",
    headline: `Announcement in ${channelId}`,
    summary: "Please review the SDK release",
    whyRelevant: "Developer impact",
    actionRequired: false,
    suggestedAction: "Review",
    sources: [
      {
        channelId,
        channelName: "dev",
        threadTs: "100.000001",
        messageTs: "100.000001",
      },
    ],
    ...overrides,
  };
}
export function digest(items = [item()]): StructuredDigest {
  return {
    title: "Briefing",
    overview: "Overview",
    items,
    omittedThreadCount: 0,
  };
}
