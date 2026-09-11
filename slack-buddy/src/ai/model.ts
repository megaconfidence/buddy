import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";

export function createSlackBuddyModel(env: {
  MISTRAL_API_KEY: string;
  MISTRAL_MODEL: string;
}): LanguageModel {
  return createMistral({ apiKey: env.MISTRAL_API_KEY })(env.MISTRAL_MODEL);
}
