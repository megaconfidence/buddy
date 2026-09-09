import type {
  DigestWindow,
  RankedDigestItem,
  StructuredDigest,
} from "../domain/types";

const SECTION_LABELS: Record<RankedDigestItem["category"], string> = {
  needs_attention: "Needs your attention",
  developer_signal: "Developer signals",
  product_change: "Product and API changes",
  content_opportunity: "Content opportunities",
  community_opportunity: "Community opportunities",
  borderline: "Possibly relevant",
};

const SECTION_ORDER: RankedDigestItem["category"][] = [
  "needs_attention",
  "developer_signal",
  "product_change",
  "content_opportunity",
  "community_opportunity",
  "borderline",
];

export function renderDigest(
  digest: StructuredDigest,
  window: DigestWindow,
  teamId: string,
): string {
  const sections = SECTION_ORDER.flatMap((category) => {
    const items = digest.items.filter((item) => item.category === category);
    if (items.length === 0) return [];
    return [
      `## ${SECTION_LABELS[category]}`,
      ...items.map((item) => renderItem(item, teamId)),
    ];
  });

  const lines = [
    `# Slack Buddy briefing · ${window.localDate}`,
    digest.overview,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ];

  if (digest.omittedThreadCount > 0) {
    lines.push(
      `_Slack Buddy reviewed additional context and omitted ${digest.omittedThreadCount} low-relevance threads._`,
    );
  }

  return lines.join("\n").trim();
}

export function renderDigestBlocks(
  digest: StructuredDigest,
  window: DigestWindow,
  teamId: string,
  digestId: string,
): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      block_id: digestMarkerBlockId(digestId),
      text: {
        type: "plain_text",
        text: `Slack Buddy briefing · ${window.localDate}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: digest.overview.slice(0, 3_000),
      },
    },
  ];

  for (const category of SECTION_ORDER) {
    const items = digest.items.filter((item) => item.category === category);
    if (items.length === 0) continue;

    blocks.push({
      type: "header",
      text: {
        type: "plain_text",
        text: SECTION_LABELS[category],
      },
    });

    for (const item of items) {
      const sourceLinks = item.sources
        .slice(0, 3)
        .map((source, index) => {
          const label = source.channelName
            ? `#${source.channelName}`
            : `source ${index + 1}`;
          return `<${slackDeepLink(teamId, source)}|${label}>`;
        })
        .join(" · ");
      const action = item.suggestedAction
        ? `\n*Suggested action:* ${item.suggestedAction}`
        : "";

      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${item.headline}*\n${item.summary}\n*Why it matters:* ${item.whyRelevant}${action}\n${sourceLinks}`.slice(
              0,
              3_000,
            ),
          },
        },
        {
          type: "actions",
          block_id: `slack-buddy:${item.id}`.slice(0, 255),
          elements: [
            feedbackButton("Relevant", "relevant", digestId, item.id),
            feedbackButton("Not relevant", "not_relevant", digestId, item.id),
            feedbackButton("Handled", "handled", digestId, item.id),
          ],
        },
      );
    }
  }

  if (digest.omittedThreadCount > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Slack Buddy omitted ${digest.omittedThreadCount} low-relevance threads.`,
        },
      ],
    });
  }

  return blocks.slice(0, 50);
}

export function digestMarkerBlockId(digestId: string): string {
  return `slack-buddy-digest:${digestId}`.slice(0, 255);
}

function renderItem(item: RankedDigestItem, teamId: string): string {
  const action = item.suggestedAction
    ? `\n  - **Suggested action:** ${item.suggestedAction}`
    : "";
  const sources = item.sources
    .slice(0, 3)
    .map((source, index) => {
      const label = source.channelName
        ? `#${source.channelName}`
        : `source ${index + 1}`;
      return `[${label}](${slackDeepLink(teamId, source)})`;
    })
    .join(" · ");

  return `- **${item.headline}** — ${item.summary}
  - **Why it matters:** ${item.whyRelevant}${action}
  - ${sources}`;
}

function slackDeepLink(
  teamId: string,
  source: RankedDigestItem["sources"][number],
): string {
  const params = new URLSearchParams({
    team: teamId,
    id: source.channelId,
    message: source.messageTs,
    thread_ts: source.threadTs,
  });
  return `slack://channel?${params.toString()}`;
}

function feedbackButton(
  label: string,
  value: "relevant" | "not_relevant" | "handled",
  digestId: string,
  itemId: string,
): unknown {
  return {
    type: "button",
    action_id: "slack_buddy_feedback",
    text: {
      type: "plain_text",
      text: label,
    },
    value: JSON.stringify({ digestId, itemId, value }),
  };
}
