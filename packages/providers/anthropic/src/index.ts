import type { ProviderAdapter } from "@ecoclaw/kernel";

const toNum = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

export const anthropicAdapter: ProviderAdapter = {
  provider: "anthropic",
  async annotatePrompt(ctx) {
    // Hook point to add cache_control on stable segments.
    return {
      ...ctx,
      metadata: {
        ...(ctx.metadata ?? {}),
        anthropicCache: { annotateStableSegments: true },
      },
    };
  },
  normalizeUsage(raw) {
    const usage = raw as any;
    const inputTokens = toNum(usage?.input_tokens ?? usage?.inputTokens);
    const outputTokens = toNum(usage?.output_tokens ?? usage?.outputTokens);
    const cacheReadTokens = toNum(usage?.cache_read_input_tokens ?? usage?.cacheReadInputTokens);
    const cacheWriteTokens = toNum(
      usage?.cache_creation_input_tokens ?? usage?.cacheCreationInputTokens,
    );
    const cacheHitTokens = cacheReadTokens;
    const cacheHitRate =
      inputTokens && inputTokens > 0 && cacheHitTokens !== undefined
        ? cacheHitTokens / inputTokens
        : undefined;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitTokens,
      cacheHitRate,
      providerRaw: raw,
    };
  },
};
