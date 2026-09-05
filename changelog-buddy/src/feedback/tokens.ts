import type { FeedbackValue } from "../domain/types";

export type FeedbackTokenPayload = {
  digestId: string;
  itemId: string;
  value: FeedbackValue;
  expiresAt: number;
};

export async function signFeedbackToken(
  secret: string,
  payload: FeedbackTokenPayload,
): Promise<string> {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(secret, encoded);
  return `${encoded}.${signature}`;
}

export async function verifyFeedbackToken(
  secret: string,
  token: string,
  nowMs = Date.now(),
): Promise<FeedbackTokenPayload | null> {
  const [encoded, providedSignature] = token.split(".");
  if (!encoded || !providedSignature) return null;
  const expectedSignature = await sign(secret, encoded);
  if (!timingSafeEqual(expectedSignature, providedSignature)) return null;

  try {
    const payload = JSON.parse(
      base64UrlDecode(encoded),
    ) as FeedbackTokenPayload;
    if (
      !payload.digestId ||
      !payload.itemId ||
      !["pursue", "not_relevant", "handled"].includes(payload.value) ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt < nowMs
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function base64UrlDecode(value: string): string {
  const padded = value
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}
