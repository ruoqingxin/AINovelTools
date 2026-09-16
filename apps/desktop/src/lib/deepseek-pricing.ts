import type { ModelProfile } from "./tauri-client";

export type DeepSeekFlashPricing = {
  period: "peak" | "idle";
  inputCacheHitMicrosPerMillion: number;
  inputCacheMissMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  currency: "CNY";
};

export function isDeepSeekFlash(profile: Pick<ModelProfile, "provider" | "modelId">) {
  return profile.provider === "DEEP_SEEK"
    && ["deepseek-flash", "deepseek-v4-flash"].includes(profile.modelId);
}

export function deepSeekFlashPricing(now = new Date()): DeepSeekFlashPricing {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const weekdayPeak = weekday !== "Sat" && weekday !== "Sun" && (
    (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
  );
  return weekdayPeak
    ? { period: "peak", inputCacheHitMicrosPerMillion: 40_000, inputCacheMissMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 8_000_000, currency: "CNY" }
    : { period: "idle", inputCacheHitMicrosPerMillion: 20_000, inputCacheMissMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 4_000_000, currency: "CNY" };
}
