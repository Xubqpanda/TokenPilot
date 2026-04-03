import type {
  CompactionArtifact,
  CompactionPlan,
  CompactionStrategyContext,
  RecentMessage,
} from "./types.js";

const clipText = (value: unknown): string => String(value ?? "").trim();

const normalizeRecentMessages = (value: unknown): RecentMessage[] =>
  Array.isArray(value) ? (value as RecentMessage[]) : [];

const normalizeTriggerReasons = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => clipText(item)).filter(Boolean)
    : [];

export function buildSummaryThenForkPlan(
  params: CompactionStrategyContext,
): CompactionPlan | null {
  const {
    artifact,
    createdAt = new Date().toISOString(),
    idFactory = () => Date.now(),
    triggerReasons,
  } = params;

  const compactionArtifact = artifact as Partial<CompactionArtifact>;
  const summaryText = clipText(compactionArtifact.summaryText);
  if (!summaryText) return null;

  const resumePrefixPrompt = clipText(compactionArtifact.resumePrefixPrompt);
  const seedSummary = clipText(compactionArtifact.seedSummary) || [resumePrefixPrompt, summaryText].filter(Boolean).join("\n\n");
  if (!seedSummary) return null;

  const stamp = idFactory();
  return {
    schemaVersion: 1,
    planId: `compact-plan-${stamp}`,
    createdAt,
    strategy: "summary_then_fork",
    targetBranch: `compact-${stamp}`,
    seedMode: "summary",
    compactionId: clipText(compactionArtifact.compactionId) || undefined,
    summaryText,
    summaryChars: summaryText.length,
    resumePrefixPrompt,
    recentMessages: normalizeRecentMessages(compactionArtifact.recentMessages),
    seedSummary,
    triggerReasons: normalizeTriggerReasons(triggerReasons),
  };
}
