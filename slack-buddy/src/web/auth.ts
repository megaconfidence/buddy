import { jwtVerify, SignJWT } from "jose";
import type { Env } from "../env";
const COOKIE = "buddy_session";
function key(env: Env) {
  if (!env.SLACK_BUDDY_WEB_SECRET || env.SLACK_BUDDY_WEB_SECRET.length < 32)
    throw new Error("web_not_configured");
  return new TextEncoder().encode(env.SLACK_BUDDY_WEB_SECRET);
}
export async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function sameOrigin(request: Request) {
  return request.headers.get("Origin") === new URL(request.url).origin;
}
export async function authenticated(request: Request, env: Env) {
  const token = request.headers
    .get("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, key(env), {
      issuer: "slack-buddy",
      audience: "web",
      algorithms: ["HS256"],
    });
    return payload.sub === env.SLACK_USER_ID;
  } catch {
    return false;
  }
}
export async function login(request: Request, env: Env, password: string) {
  key(env);
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const id = await digest(`${env.SLACK_BUDDY_WEB_SECRET}:${ip}`);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO mcp_login_attempts(key,attempts,reset_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<? THEN 1 ELSE attempts+1 END,
    reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END`,
  )
    .bind(id, now + 600_000, now, now)
    .run();
  const row = await env.DB.prepare(
    "SELECT attempts FROM mcp_login_attempts WHERE key=?",
  )
    .bind(id)
    .first<{ attempts: number }>();
  if (!row || row.attempts > 5) throw new Error("login_limited");
  const a = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)),
  );
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", key(env)));
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
  if (different) throw new Error("login_failed");
  await env.DB.prepare("DELETE FROM mcp_login_attempts WHERE key=?")
    .bind(id)
    .run();
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(env.SLACK_USER_ID)
    .setIssuer("slack-buddy")
    .setAudience("web")
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(key(env));
}
export function cookie(request: Request, env: Env, token: string) {
  const local =
    env.SLACK_BUDDY_LOCAL_DEV === "true" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname);
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 43200 : 0}${local ? "" : "; Secure"}`;
}
export async function deliveryToken(env: Env, runId: string, payload: unknown) {
  return new SignJWT({ runId, hash: await digest(JSON.stringify(payload)) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(env.SLACK_USER_ID)
    .setIssuer("slack-buddy")
    .setAudience("delivery")
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(key(env));
}
export async function verifyDelivery(
  env: Env,
  token: string,
  runId: string,
  body: unknown,
) {
  try {
    const { payload } = await jwtVerify(token, key(env), {
      issuer: "slack-buddy",
      audience: "delivery",
      algorithms: ["HS256"],
    });
    return (
      payload.sub === env.SLACK_USER_ID &&
      payload.runId === runId &&
      payload.hash === (await digest(JSON.stringify(body)))
    );
  } catch {
    return false;
  }
}
