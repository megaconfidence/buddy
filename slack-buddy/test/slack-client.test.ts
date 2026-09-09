import { describe, expect, it } from "vitest";
import { CLOUDFLARE_SLACK_WEB_CLIENT_OPTIONS } from "../src/slack/web-client";

describe("Slack Web API transport", () => {
  it("uses a cache mode supported by Cloudflare Workers", async () => {
    const interceptor = CLOUDFLARE_SLACK_WEB_CLIENT_OPTIONS.requestInterceptor;
    const config = {
      fetchOptions: { redirect: "follow" },
    } as Parameters<typeof interceptor>[0];

    const resolved = await interceptor(config);

    expect(resolved.fetchOptions).toMatchObject({
      cache: "no-store",
      redirect: "follow",
    });
  });
});
