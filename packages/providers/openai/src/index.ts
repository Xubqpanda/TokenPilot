import type { ProviderAdapter } from "@ecoclaw/kernel";

const toNum = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

export const openaiAdapter: ProviderAdapter = {
  provider: "openai",
  async annotatePrompt(ctx) {
    // OpenAI prompt caching is mostly automatic; keep prefix stable.
    return ctx;
  },
  normalizeUsage(raw) {
    const usage = raw as any;
    const inputTokens = toNum(usage?.input_tokens ?? usage?.prompt_tokens);
    const outputTokens = toNum(usage?.output_tokens ?? usage?.completion_tokens);
    const cachedTokens = toNum(
      usage?.prompt_tokens_details?.cached_tokens ?? usage?.promptTokensDetails?.cachedTokens,
    );
    const cacheHitTokens = cachedTokens;
    const cacheHitRate =
      inputTokens && inputTokens > 0 && cacheHitTokens !== undefined
        ? cacheHitTokens / inputTokens
        : undefined;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheHitTokens,
      cachedTokens,
      cacheHitTokens,
      cacheHitRate,
      providerRaw: raw,
    };
  },
};
