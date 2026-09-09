import type { SlackAdapterConfig } from "@chat-adapter/slack";

export const CLOUDFLARE_SLACK_WEB_CLIENT_OPTIONS = {
  requestInterceptor: (config) => {
    config.fetchOptions = {
      ...config.fetchOptions,
      cache: "no-store",
    };
    return config;
  },
} satisfies NonNullable<SlackAdapterConfig["webClientOptions"]>;
