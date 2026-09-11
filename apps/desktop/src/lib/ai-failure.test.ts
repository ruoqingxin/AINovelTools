import { describe, expect, it } from "vitest";
import { classifyAiFailure } from "./ai-failure";

describe("classifyAiFailure", () => {
  it.each([
    ["request timed out", "TIMEOUT"],
    ["HTTP 429 rate limit exceeded", "RATE_LIMIT"],
    ["401 unauthorized: invalid api key", "AUTH"],
    ["context length exceeded", "CONTEXT_LIMIT"],
    ["content policy rejected the request", "CONTENT_POLICY"],
    ["failed to parse JSON response", "INVALID_RESPONSE"],
    ["network connection reset", "NETWORK"],
    ["任务已取消", "CANCELLED"],
  ])("classifies %s as %s", (message, kind) => {
    expect(classifyAiFailure(message).kind).toBe(kind);
  });

  it("keeps an actionable fallback for unknown failures", () => {
    const failure = classifyAiFailure("服务商返回了未识别的错误");

    expect(failure.kind).toBe("UNKNOWN");
    expect(failure.hint).toContain("直接重试");
  });
});
