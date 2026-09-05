import type { Env } from "../env";
import type { SourceState } from "../domain/types";

const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "docs.mistral.ai",
  "github.com",
  "huggingface.co",
  "mistral.ai",
  "pypi.org",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "status.mistral.ai",
]);

export type FetchResult =
  | {
      notModified: true;
      etag: string | null;
      lastModified: string | null;
    }
  | {
      notModified: false;
      body: string;
      contentType: string;
      etag: string | null;
      lastModified: string | null;
    };

export class SourceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
  }
}

export async function fetchSource(
  env: Env,
  url: string,
  state: SourceState,
  options?: {
    accept?: string;
    maxBytes?: number;
  },
): Promise<FetchResult> {
  let current = new URL(url);
  const maxBytes = options?.maxBytes ?? 2_000_000;

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    assertAllowed(current);
    const headers = new Headers({
      Accept:
        options?.accept ?? "application/json, text/plain;q=0.9, */*;q=0.5",
      "User-Agent": "changelog-buddy/0.1 (+https://mistral.ai)",
    });
    if (state.etag) headers.set("If-None-Match", state.etag);
    if (state.lastModified) {
      headers.set("If-Modified-Since", state.lastModified);
    }
    if (current.hostname === "api.github.com" && env.GITHUB_TOKEN) {
      headers.set("Authorization", `Bearer ${env.GITHUB_TOKEN}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
    }

    const response = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");

    if (response.status === 304) {
      return { notModified: true, etag, lastModified };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) {
        throw new SourceHttpError(
          `Unusable redirect from ${current}`,
          response.status,
          null,
        );
      }
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) {
      throw new SourceHttpError(
        `Source request failed with HTTP ${response.status}`,
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new SourceHttpError(
        `Source response exceeds ${maxBytes} bytes`,
        413,
        null,
      );
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
      throw new SourceHttpError(
        `Source response exceeds ${maxBytes} bytes`,
        413,
        null,
      );
    }

    return {
      notModified: false,
      body,
      contentType: response.headers.get("content-type") ?? "text/plain",
      etag,
      lastModified,
    };
  }

  throw new SourceHttpError("Too many redirects", 508, null);
}

function assertAllowed(url: URL): void {
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new SourceHttpError(
      `Source URL is not allowlisted: ${url}`,
      403,
      null,
    );
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000))
    : null;
}
