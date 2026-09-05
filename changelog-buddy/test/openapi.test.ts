import { describe, expect, it } from "vitest";
import { semanticOpenApiDiff } from "../src/sources/snapshots";

describe("OpenAPI semantic diff", () => {
  it("reports operations and schemas rather than line noise", () => {
    const previous = `
openapi: 3.1.0
paths:
  /v1/chat:
    post:
      operationId: chat
components:
  schemas:
    ChatRequest:
      type: object
`;
    const next = `
openapi: 3.1.0
paths:
  /v1/chat:
    post:
      operationId: chat
      deprecated: true
  /v1/responses:
    post:
      operationId: responses
components:
  schemas:
    ChatRequest:
      type: object
      required: [model]
`;

    const result = semanticOpenApiDiff(previous, next);
    expect(result.summary).toContain("Added operation: POST /v1/responses");
    expect(result.summary).toContain("Changed operation: POST /v1/chat");
    expect(result.summary).toContain("Changed schema: ChatRequest");
  });
});
