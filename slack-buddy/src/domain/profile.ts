import type { RelevanceProfile } from "./types";

export const DEFAULT_PROFILE: RelevanceProfile = {
  role: "Developer Advocate at Mistral",
  mission:
    "Represent developers, improve their experience with Mistral products, and turn useful internal context into timely advocacy work.",
  currentPriorities: [],
  watchTopics: [
    "Mistral models, APIs, SDKs, tooling, documentation, and launches",
    "developer questions, confusion, friction, bugs, and recurring requests",
    "breaking changes, incidents, deprecations, migrations, and release timing",
    "content, demo, tutorial, event, partnership, and community opportunities",
    "competitive or ecosystem developments that affect Mistral developers",
  ],
  mustShowSignals: [
    "the user is directly mentioned, assigned an action, or asked a question",
    "a launch, incident, breaking change, deprecation, or deadline needs awareness",
    "multiple developers report the same problem or documentation gap",
    "a concrete developer-facing content or community opportunity appears",
  ],
  suppressSignals: [
    "routine status updates with no developer-facing consequence",
    "social chatter and acknowledgements without new information",
    "resolved operational details that require no advocacy action",
    "duplicate announcements that add no new context",
  ],
  positiveExamples: [],
  negativeExamples: [],
  relevanceThreshold: 65,
  borderlineThreshold: 45,
  version: 1,
};

export function mergeProfile(
  current: RelevanceProfile,
  update: Partial<RelevanceProfile>,
): RelevanceProfile {
  return {
    ...current,
    ...update,
    version: current.version + 1,
  };
}
