export type SourceKind =
  | "rss"
  | "github_releases"
  | "github_commits"
  | "github_advisories"
  | "pypi"
  | "npm"
  | "huggingface_models"
  | "html_snapshot"
  | "openapi";

export type SourceCategory =
  | "models_api"
  | "product"
  | "sdk_tooling"
  | "cookbook"
  | "security_lifecycle"
  | "reliability";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SourceDefinition = {
  id: string;
  name: string;
  kind: SourceKind;
  category: SourceCategory;
  url: string;
  canonicalUrl: string;
  pollIntervalMinutes: number;
  authority: number;
  options?: {
    repository?: string;
    path?: string;
    packageName?: string;
    articleSelector?: string;
  };
};

export type SourceState = {
  sourceId: string;
  etag: string | null;
  lastModified: string | null;
  cursor: string | null;
  baselined: boolean;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export type CollectedItem = {
  sourceId: string;
  externalId: string;
  canonicalUrl: string;
  title: string;
  publishedAt: number | null;
  updatedAt: number | null;
  content: string;
  contentHash: string;
  artifactKey: string | null;
  metadata: Record<string, JsonValue>;
};

export type CollectionResult = {
  notModified: boolean;
  items: CollectedItem[];
  etag: string | null;
  lastModified: string | null;
  cursor: string | null;
  snapshot?: {
    body: string;
    contentType: string;
  };
};

export type ChangeType =
  | "created"
  | "updated"
  | "deprecated"
  | "retired"
  | "yanked";

export type ChangeEvent = {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceCategory: SourceCategory;
  sourceAuthority: number;
  externalId: string;
  changeType: ChangeType;
  canonicalUrl: string;
  title: string;
  content: string;
  contentHash: string;
  artifactKey: string | null;
  publishedAt: number | null;
  detectedAt: number;
  metadata: Record<string, JsonValue>;
};

export type ChangeCluster = {
  id: string;
  title: string;
  artifactKey: string | null;
  events: ChangeEvent[];
};

export type ContentFormat = "social_post" | "demo_app" | "cookbook" | "video";

export type EditorialItem = {
  id: string;
  eventIds: string[];
  category:
    | "must_know"
    | "model_api"
    | "sdk_tooling"
    | "product"
    | "reliability"
    | "other";
  title: string;
  summary: string;
  developerImpact: string;
  importance: number;
  contentPotential: number;
  recommendedFormats: ContentFormat[];
  suggestedHook: string | null;
  demoIdea: string | null;
  effort: "low" | "medium" | "high";
  freshness: "today" | "this_week" | "evergreen";
};

export type EditorialDigest = {
  overview: string;
  items: EditorialItem[];
};

export type DigestWindow = {
  localDate: string;
  timezone: string;
  startMs: number;
  endMs: number;
};

export type ScanWorkflowParams = {
  sourceId: string;
  scheduledAt: number;
};

export type DigestWorkflowParams = {
  digestId: string;
  window: DigestWindow;
};

export type FeedbackValue = "pursue" | "not_relevant" | "handled";

export type PreferenceProfile = {
  positiveExamples: string[];
  negativeExamples: string[];
  preferredFormats: ContentFormat[];
  version: number;
};
