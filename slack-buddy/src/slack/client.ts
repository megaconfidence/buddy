import {
  assertSlackOk,
  callSlackApi as sdkCallSlackApi,
  postSlackMessage as sdkPostSlackMessage,
  updateSlackMessage as sdkUpdateSlackMessage,
  type SlackApiResponse,
} from "@chat-adapter/slack/api";

/** Retry only explicit rate-limit responses: retrying ambiguous writes can duplicate them. */
export function withRateLimitRetries(request: typeof fetch): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await request(input, init);
      const payload = response.ok
        ? ((await response
            .clone()
            .json()
            .catch(() => null)) as SlackApiResponse | null)
        : null;
      const limited =
        response.status === 429 || payload?.error === "ratelimited";
      if (!limited || attempt >= 2) return response;

      const seconds = Number(
        response.headers.get("retry-after") ?? payload?.retry_after ?? 1,
      );
      if (!Number.isFinite(seconds) || seconds < 0) return response;
      await response.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, seconds) * 1_000),
      );
    }
  };
}

export async function callSlackApi<
  T extends SlackApiResponse = SlackApiResponse,
>(
  method: string,
  body: Record<string, unknown>,
  options: Parameters<typeof sdkCallSlackApi>[2],
): Promise<T> {
  const result = await sdkCallSlackApi<T>(method, body, {
    ...options,
    fetch: withRateLimitRetries(options.fetch ?? fetch),
  });
  assertSlackOk(method, result);
  return result;
}

export function postSlackMessage(
  options: Parameters<typeof sdkPostSlackMessage>[0],
) {
  return sdkPostSlackMessage({
    ...options,
    fetch: withRateLimitRetries(options.fetch ?? fetch),
  });
}

export function updateSlackMessage(
  options: Parameters<typeof sdkUpdateSlackMessage>[0],
) {
  return sdkUpdateSlackMessage({
    ...options,
    fetch: withRateLimitRetries(options.fetch ?? fetch),
  });
}
