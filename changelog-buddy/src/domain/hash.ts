export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function safeId(value: string, maxLength = 100): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9-_]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[^a-zA-Z0-9_]+/u, "");
  return (sanitized || "buddy").slice(0, maxLength);
}

export function normalizedTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:v|version)\s*(\d)/gu, "$1")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}
