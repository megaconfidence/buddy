import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { appFetch } from "../src/web/router";
import { deliveryToken, verifyDelivery } from "../src/web/auth";
import { testDatabase } from "./helpers/database";
import { DEFAULT_SETTINGS } from "../src/mcp/settings";
import { generateBriefing, sendBriefing } from "../src/mcp/service";

vi.mock("../src/mcp/service", () => ({
  generateBriefing: vi.fn(),
  sendBriefing: vi.fn(),
}));
let db: ReturnType<typeof testDatabase>, env: Env;
beforeEach(() => {
  db = testDatabase();
  env = {
    DB: db.db,
    SLACK_USER_ID: "U1",
    MISTRAL_API_KEY: "test",
    SLACK_BUDDY_WEB_SECRET: "a-private-owner-access-key-for-testing-123456789",
    SLACK_BUDDY_LOCAL_DEV: "true",
  } as Env;
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});
const request = (
  path: string,
  body?: unknown,
  cookie?: string,
  origin = "http://localhost",
) =>
  new Request("http://localhost" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", Origin: origin }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function signIn() {
  const r = await appFetch(
    request("/api/login", { password: env.SLACK_BUDDY_WEB_SECRET }),
    env,
  );
  expect(r.status).toBe(200);
  return r.headers.get("Set-Cookie")!.split(";")[0]!;
}

describe("private MCP app boundary", () => {
  it("passes bounded follow-up context and permits only the signed reviewed briefing to be sent", async () => {
    const cookie = await signIn();
    const id = crypto.randomUUID();
    const result = {
      runId: id,
      generatedAt: Date.now(),
      window: { start: 1, end: 2 },
      briefing: { overview: "No selected items.", items: [] },
      coverage: [],
      metrics: { requests: 1, matches: 0, durationMs: 1, partial: false },
    };
    vi.mocked(generateBriefing).mockResolvedValue(result);
    vi.mocked(sendBriefing).mockResolvedValue({ sent: 1, pages: 1 });
    const conversation = [{ role: "user", content: "Tell me about OCR" }];
    const generated = await appFetch(
      request(
        "/api/generate",
        { requestId: id, question: "Any upcoming changes?", conversation },
        cookie,
      ),
      env,
    );
    expect(generated.status).toBe(200);
    expect(generateBriefing).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ conversation }),
    );
    const body = (await generated.json()) as { deliveryToken: string };
    const payload = {
      briefing: result.briefing,
      window: result.window,
      partial: false,
    };
    const changed = {
      ...payload,
      briefing: { ...payload.briefing, overview: "Altered" },
    };
    expect(
      (
        await appFetch(
          request(
            "/api/send",
            { runId: id, token: body.deliveryToken, payload: changed },
            cookie,
          ),
          env,
        )
      ).status,
    ).toBe(403);
    expect(sendBriefing).not.toHaveBeenCalled();
    expect(
      (
        await appFetch(
          request(
            "/api/send",
            { runId: id, token: body.deliveryToken, payload },
            cookie,
          ),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await appFetch(
          request(
            "/api/generate",
            {
              requestId: crypto.randomUUID(),
              question: "And now?",
              conversation: Array.from({ length: 7 }, () => conversation[0]),
            },
            cookie,
          ),
          env,
        )
      ).status,
    ).toBe(400);
  });
  it("renders a static CSP-protected shell without exposing config or credentials", async () => {
    const r = await appFetch(request("/"), env);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    const html = await r.text();
    expect(html).toContain("Know what matters");
    expect(html).not.toContain(env.SLACK_BUDDY_WEB_SECRET!);
    expect((await appFetch(request("/api/state"), env)).status).toBe(401);
  });
  it("authenticates the owner and prevents CSRF and version conflicts", async () => {
    const cookie = await signIn();
    expect(
      (await appFetch(request("/api/state", undefined, cookie), env)).status,
    ).toBe(200);
    expect(
      (
        await appFetch(
          request(
            "/api/settings",
            { settings: DEFAULT_SETTINGS, version: 0 },
            cookie,
            "https://evil.test",
          ),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await appFetch(
          request(
            "/api/settings",
            { settings: DEFAULT_SETTINGS, version: 0 },
            cookie,
          ),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await appFetch(
          request(
            "/api/settings",
            { settings: DEFAULT_SETTINGS, version: 0 },
            cookie,
          ),
          env,
        )
      ).status,
    ).toBe(409);
  });
  it("does not allow settings to turn on unapproved scheduled retrieval", async () => {
    const cookie = await signIn();
    const r = await appFetch(
      request(
        "/api/settings",
        { settings: { ...DEFAULT_SETTINGS, dailyDelivery: true }, version: 0 },
        cookie,
      ),
      env,
    );
    expect(r.status).toBe(400);
  });
  it("rejects incorrect secrets and throttles repeated guesses", async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (await appFetch(request("/api/login", { password: "wrong" }), env))
          .status,
      ).toBe(401);
    expect(
      (await appFetch(request("/api/login", { password: "wrong" }), env))
        .status,
    ).toBe(429);
  });
  it("fails closed without a configured secret and rejects tampered delivery payloads", async () => {
    const token = await deliveryToken(env, "run-1", { text: "hello" });
    expect(await verifyDelivery(env, token, "run-1", { text: "hello" })).toBe(
      true,
    );
    expect(await verifyDelivery(env, token, "run-1", { text: "changed" })).toBe(
      false,
    );
    expect(await verifyDelivery(env, token, "run-2", { text: "hello" })).toBe(
      false,
    );
    expect(
      (
        await appFetch(request("/api/state"), {
          ...env,
          SLACK_BUDDY_WEB_SECRET: undefined,
        })
      ).status,
    ).toBe(503);
  });
});
