import { describe, expect, it } from "vitest";
import { safeWorkflowId } from "../src/scheduler";

describe("workflow IDs", () => {
  it("removes unsupported characters and respects Cloudflare's limit", () => {
    const id = safeWorkflowId(
      `buddy:T123:U456:2026-09-04:${"long".repeat(30)}`,
    );
    expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u);
    expect(id.length).toBeLessThanOrEqual(100);
  });
});
