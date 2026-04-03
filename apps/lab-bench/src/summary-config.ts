import type { SummaryModuleConfig } from "@ecoclaw/layer-execution";

const readEnv = (key: string): string | undefined => {
  const value = process.env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export function resolveSummaryModuleConfig(
  base: SummaryModuleConfig = {},
): SummaryModuleConfig {
  return {
    ...base,
    summaryPrompt: readEnv("ECOCLAW_SUMMARY_PROMPT") ?? base.summaryPrompt,
    summaryPromptPath: readEnv("ECOCLAW_SUMMARY_PROMPT_PATH") ?? base.summaryPromptPath,
  };
}
