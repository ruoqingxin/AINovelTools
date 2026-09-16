import { describe, expect, it } from "vitest";
import { deepSeekFlashPricing } from "./deepseek-pricing";

describe("DeepSeek Flash pricing", () => {
  it("uses peak rates on Beijing weekday mornings", () => {
    expect(deepSeekFlashPricing(new Date("2026-09-14T01:00:00Z"))).toMatchObject({ period: "peak", inputCacheMissMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 8_000_000 });
  });

  it("uses idle rates on weekends", () => {
    expect(deepSeekFlashPricing(new Date("2026-09-12T02:00:00Z"))).toMatchObject({ period: "idle", inputCacheHitMicrosPerMillion: 20_000, inputCacheMissMicrosPerMillion: 1_000_000 });
  });
});
