export type SlackMessage = {
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  eventId: string;
  eventTime: number;
  postedAt: number;
  userId: string | null;
  text: string;
  subtype: string | null;
  editedAt: number | null;
  deletedAt: number | null;
};

export type SlackThread = {
  id: string;
  teamId: string;
  channelId: string;
  channelName: string | null;
  threadTs: string;
  startedAt: number;
  latestAt: number;
  messages: Array<{
    messageTs: string;
    userId: string | null;
    userName: string | null;
    text: string;
    postedAt: number;
  }>;
};

export type RelevanceProfile = {
  role: string;
  mission: string;
  currentPriorities: string[];
  watchTopics: string[];
  mustShowSignals: string[];
  suppressSignals: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  relevanceThreshold: number;
  borderlineThreshold: number;
  version: number;
};

export type DigestSource = {
  channelId: string;
  channelName: string | null;
  threadTs: string;
  messageTs: string;
};

export type RankedDigestItem = {
  id: string;
  relevance: number;
  category:
    | "needs_attention"
    | "developer_signal"
    | "product_change"
    | "content_opportunity"
    | "community_opportunity"
    | "borderline";
  urgency: "today" | "this_week" | "fyi";
  headline: string;
  summary: string;
  whyRelevant: string;
  actionRequired: boolean;
  suggestedAction: string | null;
  sources: DigestSource[];
};

export type StructuredDigest = {
  title: string;
  overview: string;
  items: RankedDigestItem[];
  omittedThreadCount: number;
};

export type DigestWindow = {
  localDate: string;
  timezone: string;
  startMs: number;
  endMs: number;
};

export type DigestWorkflowParams = {
  digestId: string;
  teamId: string;
  userId: string;
  window: DigestWindow;
};
