import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  resolveApiFamily,
  type ApiFamily,
  type RuntimeModule,
  type RuntimeTurnContext,
} from "@ecoclaw/kernel";
import {
  analyzePolicyLocality,
  type LocalityActionHint,
  type PolicyLocalityAnalysis,
  type PolicyLocalityConfig,
  type PolicyLocalitySignal,
} from "./locality.js";

export type PolicyModuleConfig = {
  localityEnabled?: boolean;
  localityHardLoopWindowMessages?: number;
  localityHardLoopMinRepeats?: number;
  localityStructuralPayloadMinChars?: number;
  localityErrorMinChars?: number;
  localitySubtaskBoundaryMinMessages?: number;
  summaryGenerationMode?: "llm_full_context" | "heuristic";
  summaryMaxOutputTokens?: number;
  handoffEnabled?: boolean;
  handoffGenerationMode?: "llm_full_context" | "heuristic";
  handoffMaxOutputTokens?: number;
  handoffCooldownTurns?: number;
  reductionEnabled?: boolean;
  reductionToolPayloadMinChars?: number;
  reductionFormatSlimmingEnabled?: boolean;
  reductionFormatSlimmingMinChars?: number;
  reductionSemanticEnabled?: boolean;
  reductionSemanticMinChars?: number;
  compactionEnabled?: boolean;
  compactionCooldownTurns?: number;
  requestCooldownTurns?: number;
  cacheJitterWindowTurns?: number;
  cacheMissRateThreshold?: number;
  minTurnsBeforeJitter?: number;
  cacheHealthEnabled?: boolean;
  cacheHealthIntervalSeconds?: number;
  cacheHealthMaxPromptChars?: number;
  cacheHealthHitMinTokens?: number;
  cacheHealthMissesToCold?: number;
  cacheHealthWarmSeconds?: number;
};

export type PolicyCacheHealthMode = "warm" | "uncertain" | "cold";

export type PolicyOnlineConfigSnapshot = {
  locality: PolicyLocalityConfig;
  summary: {
    generationMode: "llm_full_context" | "heuristic";
    maxOutputTokens: number;
    cooldownTurns: number;
  };
  handoff: {
    enabled: boolean;
    generationMode: "llm_full_context" | "heuristic";
    maxOutputTokens: number;
    cooldownTurns: number;
  };
  reduction: {
    enabled: boolean;
    toolPayloadMinChars: number;
    formatSlimmingEnabled: boolean;
    formatSlimmingMinChars: number;
    semanticEnabled: boolean;
    semanticMinChars: number;
  };
  compaction: {
    enabled: boolean;
    cooldownTurns: number;
  };
  cache: {
    telemetryWindowTurns: number;
    missRateThreshold: number;
    minTurnsBeforeSignal: number;
  };
  cacheHealth: {
    enabled: boolean;
    intervalSeconds: number;
    maxPromptChars: number;
    hitMinTokens: number;
    missesToCold: number;
    warmSeconds: number;
  };
};

export type PolicyOnlineStateSnapshot = {
  completedTurns: number;
  stableChars: number;
  cumulativeInputTokens: number;
  recentCacheMissRate: number;
  summaryCooldownActive: boolean;
  handoffCooldownActive: boolean;
  compactionCooldownActive: boolean;
  recentMissCount: number;
  cacheHealth: {
    mode: PolicyCacheHealthMode;
    lastCheckAtMs?: number;
    lastReadTokens?: number;
    consecutiveMisses: number;
  };
};

export type PolicyOnlineSignals = {
  stabilizerEligible: boolean;
  promptChars: number;
  reductionToolPayloadSegmentCount: number;
  reductionToolPayloadChars: number;
  summaryReasons: string[];
  handoffReasons: string[];
  reductionReasons: string[];
  compactionReasons: string[];
  locality: {
    source: PolicyLocalityAnalysis["source"];
    signalCount: number;
    dominantAction: PolicyLocalityAnalysis["dominantAction"];
    stablePrefixChars: number;
    stablePrefixShare: number;
    activeReplayMessageCount: number;
    activeReplayChars: number;
    protectedMessageIds: string[];
    protectedChars: number;
    summaryCandidateMessageIds: string[];
    summaryCandidateChars: number;
    reductionCandidateMessageIds: string[];
    reductionCandidateChars: number;
    handoffCandidateMessageIds: string[];
    handoffCandidateChars: number;
    errorCandidateMessageIds: string[];
    compactionCandidateBranchIds: string[];
    compactionCandidateReplayChars: number;
  };
  cacheHealth: {
    supported: boolean;
    due: boolean;
    planned: boolean;
    hitFresh: boolean;
  };
};

export type PolicyRoiConfidence = "low" | "medium" | "high";

export type PolicyRoiEstimate = {
  estimatedSavedTokens: number;
  estimatedCostTokens: number;
  netTokens: number;
  recommended: boolean;
  confidence: PolicyRoiConfidence;
  notes: string[];
};

export type PolicySemanticTarget = "summary" | "handoff" | "compaction";
export type PolicySemanticPurpose = "range_summary" | "checkpoint_seed" | "task_handoff";
export type PolicySemanticGenerationMode = "llm_full_context" | "heuristic";
export type PolicySemanticArbitration =
  | "not_requested"
  | "direct"
  | "llm_budget_owner"
  | "llm_budget_downgrade";

export type PolicyReductionRoiSnapshot = {
  beforeCall: PolicyRoiEstimate;
  afterCall: PolicyRoiEstimate;
  passes: Record<string, PolicyRoiEstimate>;
};

export type PolicyOnlineRoiSnapshot = {
  summary: PolicyRoiEstimate;
  handoff: PolicyRoiEstimate;
  compaction: PolicyRoiEstimate;
  reduction: PolicyReductionRoiSnapshot;
};

export type PolicySummaryDecision = {
  enabled: boolean;
  purpose: "range_summary";
  requested: boolean;
  reasons: string[];
  cooldownActive: boolean;
  generationMode: PolicySemanticGenerationMode;
  arbitration: PolicySemanticArbitration;
};

export type PolicyHandoffDecision = {
  enabled: boolean;
  purpose: "task_handoff";
  requested: boolean;
  reasons: string[];
  cooldownActive: boolean;
  generationMode: PolicySemanticGenerationMode;
  arbitration: PolicySemanticArbitration;
};

export type PolicyCompactionDecision = {
  supported: boolean;
  enabled: boolean;
  purpose: "checkpoint_seed";
  requested: boolean;
  reasons: string[];
  cooldownActive: boolean;
  generationMode: PolicySemanticGenerationMode;
  arbitration: PolicySemanticArbitration;
};

export type PolicyCacheHealthDecision = {
  enabled: boolean;
  supported: boolean;
  mode: PolicyCacheHealthMode;
  due: boolean;
  planned: boolean;
  promptChars: number;
  lastCheckAtMs?: number;
  lastReadTokens?: number;
  consecutiveMisses: number;
  hitFresh: boolean;
};

export type PolicySemanticBudgetDecision = {
  configuredGenerationMode: PolicySemanticGenerationMode;
  maxLlmCallsThisTurn: number;
  plannedLlmCalls: PolicySemanticTarget[];
  heuristicFallbacks: PolicySemanticTarget[];
  llmBudgetOwner?: PolicySemanticTarget;
};

export type PolicyLocalityDecision = {
  enabled: boolean;
  dominantAction: LocalityActionHint | "mixed" | "observe";
  signalCount: number;
  protectedMessageIds: string[];
  summaryCandidateMessageIds: string[];
  reductionCandidateMessageIds: string[];
  handoffCandidateMessageIds: string[];
  errorCandidateMessageIds: string[];
  compactionCandidateBranchIds: string[];
  signals: PolicyLocalitySignal[];
};

export type PolicyOnlineDecisions = {
  summary: PolicySummaryDecision;
  handoff: PolicyHandoffDecision;
  reduction: {
    enabled: boolean;
    beforeCallPassIds: string[];
    afterCallPassIds: string[];
    reasons: string[];
  };
  compaction: PolicyCompactionDecision;
  locality: PolicyLocalityDecision;
  cacheHealth: PolicyCacheHealthDecision;
  semantic: PolicySemanticBudgetDecision;
};

export type PolicyOnlineMetadata = {
  version: "v2";
  mode: "online";
  apiFamily: ApiFamily;
  config: PolicyOnlineConfigSnapshot;
  state: PolicyOnlineStateSnapshot;
  signals: PolicyOnlineSignals;
  roi: PolicyOnlineRoiSnapshot;
  decisions: PolicyOnlineDecisions;
};

type PolicySessionState = {
  completedTurns: number;
  lastSummaryRequestTurn?: number;
  lastHandoffRequestTurn?: number;
  lastCompactionRequestTurn?: number;
  recentCacheReadHit: number[];
  cumulativeInputTokens: number;
  cacheHealth: {
    mode: PolicyCacheHealthMode;
    lastCheckAtMs?: number;
    lastHitAtMs?: number;
    lastReadTokens?: number;
    consecutiveMisses: number;
  };
};

type NormalizedPolicyConfig = {
  locality: PolicyLocalityConfig;
  summaryGenerationMode: PolicySemanticGenerationMode;
  summaryMaxOutputTokens: number;
  handoffEnabled: boolean;
  handoffGenerationMode: PolicySemanticGenerationMode;
  handoffMaxOutputTokens: number;
  handoffCooldownTurns: number;
  reductionEnabled: boolean;
  reductionToolPayloadMinChars: number;
  reductionFormatSlimmingEnabled: boolean;
  reductionFormatSlimmingMinChars: number;
  reductionSemanticEnabled: boolean;
  reductionSemanticMinChars: number;
  compactionEnabled: boolean;
  compactionCooldownTurns: number;
  requestCooldownTurns: number;
  cacheJitterWindowTurns: number;
  cacheMissRateThreshold: number;
  minTurnsBeforeJitter: number;
  cacheHealthEnabled: boolean;
  cacheHealthIntervalSeconds: number;
  cacheHealthMaxPromptChars: number;
  cacheHealthHitMinTokens: number;
  cacheHealthMissesToCold: number;
  cacheHealthWarmSeconds: number;
};

type PolicyAnalysis = {
  stableChars: number;
  recentCacheMissRate: number;
  recentMissCount: number;
  promptChars: number;
  reductionToolPayloadSegmentCount: number;
  reductionToolPayloadChars: number;
  summaryReasons: string[];
  handoffReasons: string[];
  reductionReasons: string[];
  reductionBeforeCallPassIds: string[];
  reductionAfterCallPassIds: string[];
  compactionReasons: string[];
  locality: PolicyLocalityAnalysis;
  roi: PolicyOnlineRoiSnapshot;
  summaryCooldownActive: boolean;
  handoffCooldownActive: boolean;
  compactionCooldownActive: boolean;
  requestSummary: boolean;
  requestHandoff: boolean;
  requestCompaction: boolean;
  summaryGenerationMode: PolicySemanticGenerationMode;
  handoffGenerationMode: PolicySemanticGenerationMode;
  compactionGenerationMode: PolicySemanticGenerationMode;
  summaryArbitration: PolicySemanticArbitration;
  handoffArbitration: PolicySemanticArbitration;
  compactionArbitration: PolicySemanticArbitration;
  semanticBudget: PolicySemanticBudgetDecision;
  cacheHealth: {
    supported: boolean;
    due: boolean;
    planned: boolean;
    hitFresh: boolean;
    mode: PolicyCacheHealthMode;
  };
};

const POLICY_DEFAULT_CHARS_PER_TOKEN = 4;
const POLICY_DEFAULT_SUMMARY_COMPRESSION_RATIO = 0.22;
const POLICY_DEFAULT_TOOL_TRIM_KEEP_RATIO = 0.35;
const POLICY_DEFAULT_FORMAT_SLIMMING_RATIO = 0.02;
const POLICY_DEFAULT_FORMAT_SLIMMING_MIN_SAVED_TOKENS = 8;
const POLICY_DEFAULT_SUMMARY_MIN_NET_TOKENS = 24;
const POLICY_DEFAULT_HANDOFF_MIN_NET_TOKENS = 24;
const POLICY_DEFAULT_COMPACTION_MIN_NET_TOKENS = 48;
const POLICY_DEFAULT_HANDOFF_FUTURE_REUSE_MIN = 2;
const POLICY_DEFAULT_HANDOFF_FUTURE_REUSE_MAX = 5;
const POLICY_DEFAULT_COMPACTION_FUTURE_TURNS_MIN = 2;
const POLICY_DEFAULT_COMPACTION_FUTURE_TURNS_MAX = 5;

const toNum = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))];
}

function createInitialPolicySessionState(): PolicySessionState {
  return {
    completedTurns: 0,
    recentCacheReadHit: [],
    cumulativeInputTokens: 0,
    cacheHealth: {
      mode: "uncertain",
      consecutiveMisses: 0,
    },
  };
}

function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.round(chars / POLICY_DEFAULT_CHARS_PER_TOKEN));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildRoiEstimate(params: {
  savedTokens: number;
  costTokens?: number;
  minNetTokens?: number;
  confidence?: PolicyRoiConfidence;
  notes?: string[];
}): PolicyRoiEstimate {
  const estimatedSavedTokens = Math.max(0, Math.round(params.savedTokens));
  const estimatedCostTokens = Math.max(0, Math.round(params.costTokens ?? 0));
  const netTokens = estimatedSavedTokens - estimatedCostTokens;
  return {
    estimatedSavedTokens,
    estimatedCostTokens,
    netTokens,
    recommended: netTokens >= Math.max(0, params.minNetTokens ?? 0),
    confidence: params.confidence ?? "medium",
    notes: params.notes ?? [],
  };
}

function readInputTokens(usage: unknown): number {
  const usageRecord = asRecord(usage);
  const direct = toNum(usageRecord?.inputTokens);
  if (direct !== undefined) return direct;
  const raw = asRecord(usageRecord?.providerRaw);
  return toNum(raw?.input_tokens ?? raw?.prompt_tokens ?? raw?.inputTokens ?? raw?.promptTokens) ?? 0;
}

function readStableChars(ctx: RuntimeTurnContext): number {
  return ctx.segments
    .filter((segment) => segment.kind === "stable")
    .map((segment) => segment.text)
    .join("\n").length;
}

function isLikelyReductionToolPayloadSegment(segment: RuntimeTurnContext["segments"][number]): boolean {
  const metadata = asRecord(segment.metadata);
  const reduction = asRecord(metadata?.reduction);
  const toolPayload = asRecord(metadata?.toolPayload);
  const reductionTrim = asRecord(reduction?.toolPayloadTrim);
  const payloadKind = [reductionTrim?.kind, toolPayload?.kind, reduction?.payloadKind, metadata?.payloadKind]
    .find((value) => typeof value === "string");
  if (payloadKind) return true;

  const explicitEnabled =
    reductionTrim?.enabled === true ||
    toolPayload?.enabled === true ||
    metadata?.isToolPayload === true ||
    reduction?.target === "tool_payload";
  if (explicitEnabled) return true;

  const role = typeof metadata?.role === "string" ? metadata.role : "";
  if (/tool|observation/i.test(role)) return true;

  const head = String(segment.text ?? "").slice(0, 600);
  const haystack = [segment.id, segment.source, head].filter(Boolean).join("\n");
  if (/(tool|observation|artifact|payload|stdout|stderr|blob)/i.test(haystack)) return true;
  if (/(^|\n)\s*(stdout|stderr|json|blob)\s*[:=-]/i.test(head)) return true;
  if (/^\s*[\[{]/.test(head.trim())) return true;
  if (/^data:[^;]+;base64,/i.test(head.trim())) return true;
  return false;
}

function collectReductionToolPayloadStats(ctx: RuntimeTurnContext): {
  segmentCount: number;
  chars: number;
} {
  return ctx.segments.reduce(
    (acc, segment) => {
      if (!isLikelyReductionToolPayloadSegment(segment)) return acc;
      acc.segmentCount += 1;
      acc.chars += segment.text.length;
      return acc;
    },
    { segmentCount: 0, chars: 0 },
  );
}

function readStabilizerEligible(ctx: RuntimeTurnContext): boolean {
  const stabilizerMeta = asRecord(ctx.metadata?.stabilizer);
  return Boolean(stabilizerMeta?.eligible);
}

export function readPolicyOnlineMetadata(
  metadata?: Record<string, unknown>,
): PolicyOnlineMetadata | undefined {
  const policy = asRecord(metadata?.policy);
  if (!policy) return undefined;
  if (policy.version === "v2" && policy.mode === "online") {
    return policy as PolicyOnlineMetadata;
  }
  return undefined;
}

function normalizeConfig(cfg: PolicyModuleConfig): NormalizedPolicyConfig {
  return {
    locality: {
      enabled: cfg.localityEnabled ?? true,
      hardLoopWindowMessages: Math.max(3, cfg.localityHardLoopWindowMessages ?? 8),
      hardLoopMinRepeats: Math.max(2, cfg.localityHardLoopMinRepeats ?? 2),
      structuralPayloadMinChars: Math.max(40, cfg.localityStructuralPayloadMinChars ?? 120),
      errorMinChars: Math.max(16, cfg.localityErrorMinChars ?? 24),
      subtaskBoundaryMinMessages: Math.max(2, cfg.localitySubtaskBoundaryMinMessages ?? 2),
    },
    summaryGenerationMode: cfg.summaryGenerationMode ?? "heuristic",
    summaryMaxOutputTokens: Math.max(128, cfg.summaryMaxOutputTokens ?? 1200),
    handoffEnabled: cfg.handoffEnabled ?? false,
    handoffGenerationMode: cfg.handoffGenerationMode ?? "heuristic",
    handoffMaxOutputTokens: Math.max(128, cfg.handoffMaxOutputTokens ?? 900),
    handoffCooldownTurns: Math.max(0, cfg.handoffCooldownTurns ?? 4),
    reductionEnabled: cfg.reductionEnabled ?? true,
    reductionToolPayloadMinChars: Math.max(1, cfg.reductionToolPayloadMinChars ?? 200),
    reductionFormatSlimmingEnabled: cfg.reductionFormatSlimmingEnabled ?? true,
    reductionFormatSlimmingMinChars: Math.max(1, cfg.reductionFormatSlimmingMinChars ?? 1200),
    reductionSemanticEnabled: cfg.reductionSemanticEnabled ?? false,
    reductionSemanticMinChars: Math.max(1, cfg.reductionSemanticMinChars ?? 4000),
    compactionEnabled: cfg.compactionEnabled ?? true,
    compactionCooldownTurns: Math.max(0, cfg.compactionCooldownTurns ?? 6),
    requestCooldownTurns: Math.max(0, cfg.requestCooldownTurns ?? 2),
    cacheJitterWindowTurns: Math.max(3, cfg.cacheJitterWindowTurns ?? 6),
    cacheMissRateThreshold: Math.min(1, Math.max(0, cfg.cacheMissRateThreshold ?? 0.5)),
    minTurnsBeforeJitter: Math.max(1, cfg.minTurnsBeforeJitter ?? 4),
    cacheHealthEnabled: cfg.cacheHealthEnabled ?? true,
    cacheHealthIntervalSeconds: Math.max(30, cfg.cacheHealthIntervalSeconds ?? 1800),
    cacheHealthMaxPromptChars: Math.max(1, cfg.cacheHealthMaxPromptChars ?? 120),
    cacheHealthHitMinTokens: Math.max(0, cfg.cacheHealthHitMinTokens ?? 64),
    cacheHealthMissesToCold: Math.max(1, cfg.cacheHealthMissesToCold ?? 2),
    cacheHealthWarmSeconds: Math.max(30, cfg.cacheHealthWarmSeconds ?? 7200),
  };
}

function collectSignalReasons(
  locality: PolicyLocalityAnalysis,
  action: "summary" | "handoff" | "reduction" | "compaction",
): string[] {
  const reasons: string[] = [];
  for (const signal of locality.signals) {
    if (!signal.actionHints.includes(action)) continue;
    switch (signal.kind) {
      case "subtask_boundary":
        reasons.push("locality_subtask_boundary");
        break;
      case "hard_loop_detected":
        reasons.push("locality_hard_loop_detected");
        break;
      case "error_detected":
        reasons.push(action === "reduction" ? "locality_error_prune" : "locality_error_detected");
        break;
      case "structural_payload_detected":
        reasons.push("locality_structural_payload_detected");
        break;
      case "content_type_prior":
        reasons.push("locality_content_type_prior");
        break;
      default:
        reasons.push(`locality_${signal.kind}`);
        break;
    }
  }
  return uniqueStrings(reasons);
}

function analyzePolicyBeforeBuild(
  ctx: RuntimeTurnContext,
  state: PolicySessionState,
  apiFamily: ApiFamily,
  config: NormalizedPolicyConfig,
): PolicyAnalysis {
  const nowMs = Date.now();
  const stableChars = readStableChars(ctx);
  const stabilizerEligible = readStabilizerEligible(ctx);
  const reductionStats = collectReductionToolPayloadStats(ctx);
  const locality = analyzePolicyLocality({
    ctx,
    cfg: config.locality,
  });

  const recent = state.recentCacheReadHit.slice(-config.cacheJitterWindowTurns);
  const recentMissCount = recent.filter((value) => value === 0).length;
  const recentCacheMissRate = recent.length > 0 ? recentMissCount / recent.length : 0;

  const cacheHealthSupported = apiFamily !== "openai-completions";
  const promptChars = String(ctx.prompt ?? "").length;
  const cacheHealthDue =
    config.cacheHealthEnabled &&
    cacheHealthSupported &&
    stabilizerEligible &&
    (state.cacheHealth.lastCheckAtMs == null ||
      nowMs - state.cacheHealth.lastCheckAtMs >= config.cacheHealthIntervalSeconds * 1000);
  const cacheHealthPlanned = cacheHealthDue && promptChars <= config.cacheHealthMaxPromptChars;
  const cacheHealthHitFresh =
    typeof state.cacheHealth.lastHitAtMs === "number" &&
    nowMs - state.cacheHealth.lastHitAtMs <= config.cacheHealthWarmSeconds * 1000;

  let cacheHealthMode: PolicyCacheHealthMode = state.cacheHealth.mode;
  if (cacheHealthHitFresh) {
    cacheHealthMode = "warm";
  } else if (state.cacheHealth.consecutiveMisses >= config.cacheHealthMissesToCold) {
    cacheHealthMode = "cold";
  } else {
    cacheHealthMode = "uncertain";
  }
  state.cacheHealth.mode = cacheHealthMode;

  const stableTokens = estimateTokensFromChars(stableChars);
  const promptTokensEstimate = estimateTokensFromChars(promptChars);
  const reductionTargetTokens = estimateTokensFromChars(locality.reductionCandidateChars);
  const summaryTargetTokens = estimateTokensFromChars(locality.summaryCandidateChars);
  const handoffTargetTokens = estimateTokensFromChars(
    Math.max(locality.handoffCandidateChars, locality.summaryCandidateChars),
  );
  const compactionTargetTokens = estimateTokensFromChars(
    Math.max(locality.compactionCandidateReplayChars, locality.summaryCandidateChars, stableChars),
  );
  const reductionToolPayloadTokens = estimateTokensFromChars(reductionStats.chars);
  const expectedCompactionFutureTurns = clamp(
    Math.ceil((state.completedTurns + 1) / 3),
    POLICY_DEFAULT_COMPACTION_FUTURE_TURNS_MIN,
    POLICY_DEFAULT_COMPACTION_FUTURE_TURNS_MAX,
  );
  const expectedHandoffReuseTurns = clamp(
    Math.ceil((state.completedTurns + 1) / 2),
    POLICY_DEFAULT_HANDOFF_FUTURE_REUSE_MIN,
    POLICY_DEFAULT_HANDOFF_FUTURE_REUSE_MAX,
  );

  const toolTrimSavedTokens = Math.max(
    reductionTargetTokens,
    Math.round(reductionToolPayloadTokens * (1 - POLICY_DEFAULT_TOOL_TRIM_KEEP_RATIO)),
  );
  const formatSlimmingSavedTokens = Math.max(
    POLICY_DEFAULT_FORMAT_SLIMMING_MIN_SAVED_TOKENS,
    Math.round(promptTokensEstimate * POLICY_DEFAULT_FORMAT_SLIMMING_RATIO),
  );
  const summaryEstimatedOutputTokens = Math.max(
    32,
    Math.round(summaryTargetTokens * POLICY_DEFAULT_SUMMARY_COMPRESSION_RATIO),
  );
  const summaryEstimatedCostTokens =
    config.summaryGenerationMode === "heuristic"
      ? 0
      : promptTokensEstimate + Math.min(config.summaryMaxOutputTokens, Math.max(summaryEstimatedOutputTokens, 64));
  const summaryEstimatedBenefitTokens = summaryTargetTokens * Math.max(1, expectedHandoffReuseTurns - 1);
  const handoffEstimatedCostTokens =
    config.handoffGenerationMode === "heuristic"
      ? 0
      : promptTokensEstimate + config.handoffMaxOutputTokens;
  const handoffEstimatedBenefitTokens = Math.round(
    (handoffTargetTokens + Math.round(promptTokensEstimate * 0.4)) * expectedHandoffReuseTurns,
  );
  const compactionEstimatedCostTokens =
    config.summaryGenerationMode === "heuristic"
      ? 0
      : Math.min(config.summaryMaxOutputTokens, Math.max(64, Math.round(compactionTargetTokens * 0.28)));
  const compactionEstimatedBenefitTokens = compactionTargetTokens * expectedCompactionFutureTurns;

  const reductionPassRoi: Record<string, PolicyRoiEstimate> = {
    tool_payload_trim: buildRoiEstimate({
      savedTokens: toolTrimSavedTokens,
      costTokens: 0,
      minNetTokens: 1,
      confidence: reductionStats.segmentCount > 0 || locality.reductionCandidateChars > 0 ? "high" : "low",
      notes: [
        `tool_payload_chars=${reductionStats.chars}`,
        `locality_reduction_chars=${locality.reductionCandidateChars}`,
      ],
    }),
    format_slimming: buildRoiEstimate({
      savedTokens: formatSlimmingSavedTokens,
      costTokens: 0,
      minNetTokens: 1,
      confidence:
        locality.reductionCandidateChars > 0 || reductionStats.segmentCount > 0 ? "medium" : "low",
      notes: [
        `prompt_tokens_estimate=${promptTokensEstimate}`,
        `savings_ratio=${POLICY_DEFAULT_FORMAT_SLIMMING_RATIO}`,
      ],
    }),
    semantic_llmlingua2: buildRoiEstimate({
      savedTokens: 0,
      costTokens: 0,
      minNetTokens: 0,
      confidence: "low",
      notes: [
        "post_call_observed_only",
        `min_input_chars=${config.reductionSemanticMinChars}`,
      ],
    }),
  };

  const reductionBeforeCallRoi = buildRoiEstimate({
    savedTokens:
      reductionPassRoi.tool_payload_trim.estimatedSavedTokens +
      Math.round(reductionTargetTokens * 0.35),
    costTokens: 0,
    minNetTokens: 1,
    confidence: reductionPassRoi.tool_payload_trim.confidence,
    notes: ["aggregate_before_call"],
  });
  const reductionAfterCallRoi = buildRoiEstimate({
    savedTokens: reductionPassRoi.format_slimming.estimatedSavedTokens,
    costTokens: 0,
    minNetTokens: 0,
    confidence: "low",
    notes: ["semantic_requires_observed_output"],
  });
  const summaryRoi = buildRoiEstimate({
    savedTokens: summaryEstimatedBenefitTokens,
    costTokens: summaryEstimatedCostTokens,
    minNetTokens: config.summaryGenerationMode === "heuristic" ? 0 : POLICY_DEFAULT_SUMMARY_MIN_NET_TOKENS,
    confidence: config.summaryGenerationMode === "heuristic" ? "high" : "medium",
    notes: [
      `summary_candidate_tokens=${summaryTargetTokens}`,
      `generation_mode=${config.summaryGenerationMode}`,
    ],
  });
  const handoffRoi = buildRoiEstimate({
    savedTokens: handoffEstimatedBenefitTokens,
    costTokens: handoffEstimatedCostTokens,
    minNetTokens:
      config.handoffGenerationMode === "heuristic" ? 0 : POLICY_DEFAULT_HANDOFF_MIN_NET_TOKENS,
    confidence: config.handoffGenerationMode === "heuristic" ? "medium" : "low",
    notes: [
      `handoff_candidate_tokens=${handoffTargetTokens}`,
      `expected_reuse_turns=${expectedHandoffReuseTurns}`,
      `generation_mode=${config.handoffGenerationMode}`,
    ],
  });
  const compactionRoi = buildRoiEstimate({
    savedTokens: compactionEstimatedBenefitTokens,
    costTokens: compactionEstimatedCostTokens,
    minNetTokens:
      config.summaryGenerationMode === "heuristic" ? 0 : POLICY_DEFAULT_COMPACTION_MIN_NET_TOKENS,
    confidence: config.summaryGenerationMode === "heuristic" ? "medium" : "high",
    notes: [
      `compaction_candidate_tokens=${compactionTargetTokens}`,
      `expected_future_turns=${expectedCompactionFutureTurns}`,
      `generation_mode=${config.summaryGenerationMode}`,
    ],
  });

  const roi: PolicyOnlineRoiSnapshot = {
    summary: summaryRoi,
    handoff: handoffRoi,
    compaction: compactionRoi,
    reduction: {
      beforeCall: reductionBeforeCallRoi,
      afterCall: reductionAfterCallRoi,
      passes: reductionPassRoi,
    },
  };

  const summaryReasons = collectSignalReasons(locality, "summary");
  const handoffReasons = config.handoffEnabled ? collectSignalReasons(locality, "handoff") : [];
  const compactionSupported = apiFamily === "openai-responses";
  const compactionReasons =
    compactionSupported && config.compactionEnabled ? collectSignalReasons(locality, "compaction") : [];

  const reductionReasons: string[] = [];
  const reductionBeforeCallPassIds: string[] = [];
  const reductionAfterCallPassIds: string[] = [];
  const localityReductionReasons = collectSignalReasons(locality, "reduction");
  reductionReasons.push(...localityReductionReasons);
  if (
    config.reductionEnabled &&
    (reductionStats.segmentCount > 0 || localityReductionReasons.length > 0) &&
    reductionPassRoi.tool_payload_trim.recommended
  ) {
    reductionReasons.push("tool_payload_detected");
    reductionBeforeCallPassIds.push("tool_payload_trim");
  }
  if (
    config.reductionFormatSlimmingEnabled &&
    (promptChars >= config.reductionFormatSlimmingMinChars || localityReductionReasons.length > 0) &&
    reductionPassRoi.format_slimming.recommended
  ) {
    reductionReasons.push("format_slimming_candidate");
    reductionAfterCallPassIds.push("format_slimming");
  }
  if (config.reductionSemanticEnabled && reductionPassRoi.semantic_llmlingua2.recommended) {
    reductionReasons.push("semantic_candidate");
    reductionAfterCallPassIds.push("semantic_llmlingua2");
  }

  const summaryCooldownActive =
    typeof state.lastSummaryRequestTurn === "number" &&
    state.completedTurns - state.lastSummaryRequestTurn <= config.requestCooldownTurns;
  const handoffCooldownActive =
    typeof state.lastHandoffRequestTurn === "number" &&
    state.completedTurns - state.lastHandoffRequestTurn <= config.handoffCooldownTurns;
  const compactionCooldownActive =
    typeof state.lastCompactionRequestTurn === "number" &&
    state.completedTurns - state.lastCompactionRequestTurn <= config.compactionCooldownTurns;

  const requestSummary =
    summaryReasons.length > 0 &&
    !summaryCooldownActive &&
    summaryRoi.recommended;
  const requestHandoff =
    config.handoffEnabled &&
    handoffReasons.length > 0 &&
    !handoffCooldownActive &&
    handoffRoi.recommended;
  const requestCompaction =
    compactionSupported &&
    config.compactionEnabled &&
    compactionReasons.length > 0 &&
    !compactionCooldownActive &&
    compactionRoi.recommended;

  let summaryGenerationMode: PolicySemanticGenerationMode = requestSummary
    ? config.summaryGenerationMode
    : "heuristic";
  let handoffGenerationMode: PolicySemanticGenerationMode = requestHandoff
    ? config.handoffGenerationMode
    : "heuristic";
  let compactionGenerationMode: PolicySemanticGenerationMode = requestCompaction
    ? config.summaryGenerationMode
    : "heuristic";
  let summaryArbitration: PolicySemanticArbitration = requestSummary ? "direct" : "not_requested";
  let handoffArbitration: PolicySemanticArbitration = requestHandoff ? "direct" : "not_requested";
  let compactionArbitration: PolicySemanticArbitration = requestCompaction ? "direct" : "not_requested";
  const semanticBudget: PolicySemanticBudgetDecision = {
    configuredGenerationMode:
      requestCompaction && config.summaryGenerationMode === "llm_full_context"
        ? "llm_full_context"
        : requestHandoff && config.handoffGenerationMode === "llm_full_context"
          ? "llm_full_context"
          : config.summaryGenerationMode,
    maxLlmCallsThisTurn: 1,
    plannedLlmCalls: [],
    heuristicFallbacks: [],
  };

  const llmCandidates: PolicySemanticTarget[] = [];
  if (requestSummary && config.summaryGenerationMode === "llm_full_context") llmCandidates.push("summary");
  if (requestHandoff && config.handoffGenerationMode === "llm_full_context") llmCandidates.push("handoff");
  if (requestCompaction && config.summaryGenerationMode === "llm_full_context") llmCandidates.push("compaction");

  if (llmCandidates.length === 1) {
    const owner = llmCandidates[0];
    semanticBudget.llmBudgetOwner = owner;
    semanticBudget.plannedLlmCalls.push(owner);
    if (owner === "summary") summaryArbitration = "llm_budget_owner";
    else if (owner === "handoff") handoffArbitration = "llm_budget_owner";
    else compactionArbitration = "llm_budget_owner";
  } else if (llmCandidates.length > 1) {
    const roiByTarget: Record<PolicySemanticTarget, PolicyRoiEstimate> = {
      summary: summaryRoi,
      handoff: handoffRoi,
      compaction: compactionRoi,
    };
    const priority: PolicySemanticTarget[] = ["compaction", "handoff", "summary"];
    const llmBudgetOwner = llmCandidates
      .slice()
      .sort((left, right) => {
        const netDiff = roiByTarget[right].netTokens - roiByTarget[left].netTokens;
        if (netDiff !== 0) return netDiff;
        return priority.indexOf(left) - priority.indexOf(right);
      })[0];
    const downgradedTargets = llmCandidates.filter((target) => target !== llmBudgetOwner);
    semanticBudget.llmBudgetOwner = llmBudgetOwner;
    semanticBudget.plannedLlmCalls.push(llmBudgetOwner);
    semanticBudget.heuristicFallbacks.push(...downgradedTargets);
    if (llmBudgetOwner === "summary") summaryArbitration = "llm_budget_owner";
    if (llmBudgetOwner === "handoff") handoffArbitration = "llm_budget_owner";
    if (llmBudgetOwner === "compaction") compactionArbitration = "llm_budget_owner";
    if (downgradedTargets.includes("summary")) {
      summaryGenerationMode = "heuristic";
      summaryArbitration = "llm_budget_downgrade";
    }
    if (downgradedTargets.includes("handoff")) {
      handoffGenerationMode = "heuristic";
      handoffArbitration = "llm_budget_downgrade";
    }
    if (downgradedTargets.includes("compaction")) {
      compactionGenerationMode = "heuristic";
      compactionArbitration = "llm_budget_downgrade";
    }
  }

  return {
    stableChars,
    recentCacheMissRate,
    recentMissCount,
    promptChars,
    reductionToolPayloadSegmentCount: reductionStats.segmentCount,
    reductionToolPayloadChars: reductionStats.chars,
    summaryReasons,
    handoffReasons,
    reductionReasons: uniqueStrings(reductionReasons),
    reductionBeforeCallPassIds: uniqueStrings(reductionBeforeCallPassIds),
    reductionAfterCallPassIds: uniqueStrings(reductionAfterCallPassIds),
    compactionReasons,
    locality,
    roi,
    summaryCooldownActive,
    handoffCooldownActive,
    compactionCooldownActive,
    requestSummary,
    requestHandoff,
    requestCompaction,
    summaryGenerationMode,
    handoffGenerationMode,
    compactionGenerationMode,
    summaryArbitration,
    handoffArbitration,
    compactionArbitration,
    semanticBudget,
    cacheHealth: {
      supported: cacheHealthSupported,
      due: cacheHealthDue,
      planned: cacheHealthPlanned,
      hitFresh: cacheHealthHitFresh,
      mode: cacheHealthMode,
    },
  };
}

function buildPolicyMetadata(
  apiFamily: ApiFamily,
  state: PolicySessionState,
  analysis: PolicyAnalysis,
  config: NormalizedPolicyConfig,
  stabilizerEligible: boolean,
): PolicyOnlineMetadata {
  return {
    version: "v2",
    mode: "online",
    apiFamily,
    config: {
      locality: config.locality,
      summary: {
        generationMode: config.summaryGenerationMode,
        maxOutputTokens: config.summaryMaxOutputTokens,
        cooldownTurns: config.requestCooldownTurns,
      },
      handoff: {
        enabled: config.handoffEnabled,
        generationMode: config.handoffGenerationMode,
        maxOutputTokens: config.handoffMaxOutputTokens,
        cooldownTurns: config.handoffCooldownTurns,
      },
      reduction: {
        enabled: config.reductionEnabled,
        toolPayloadMinChars: config.reductionToolPayloadMinChars,
        formatSlimmingEnabled: config.reductionFormatSlimmingEnabled,
        formatSlimmingMinChars: config.reductionFormatSlimmingMinChars,
        semanticEnabled: config.reductionSemanticEnabled,
        semanticMinChars: config.reductionSemanticMinChars,
      },
      compaction: {
        enabled: config.compactionEnabled,
        cooldownTurns: config.compactionCooldownTurns,
      },
      cache: {
        telemetryWindowTurns: config.cacheJitterWindowTurns,
        missRateThreshold: config.cacheMissRateThreshold,
        minTurnsBeforeSignal: config.minTurnsBeforeJitter,
      },
      cacheHealth: {
        enabled: config.cacheHealthEnabled,
        intervalSeconds: config.cacheHealthIntervalSeconds,
        maxPromptChars: config.cacheHealthMaxPromptChars,
        hitMinTokens: config.cacheHealthHitMinTokens,
        missesToCold: config.cacheHealthMissesToCold,
        warmSeconds: config.cacheHealthWarmSeconds,
      },
    },
    state: {
      completedTurns: state.completedTurns,
      stableChars: analysis.stableChars,
      cumulativeInputTokens: state.cumulativeInputTokens,
      recentCacheMissRate: analysis.recentCacheMissRate,
      summaryCooldownActive: analysis.summaryCooldownActive,
      handoffCooldownActive: analysis.handoffCooldownActive,
      compactionCooldownActive: analysis.compactionCooldownActive,
      recentMissCount: analysis.recentMissCount,
      cacheHealth: {
        mode: analysis.cacheHealth.mode,
        lastCheckAtMs: state.cacheHealth.lastCheckAtMs,
        lastReadTokens: state.cacheHealth.lastReadTokens,
        consecutiveMisses: state.cacheHealth.consecutiveMisses,
      },
    },
    signals: {
      stabilizerEligible,
      promptChars: analysis.promptChars,
      reductionToolPayloadSegmentCount: analysis.reductionToolPayloadSegmentCount,
      reductionToolPayloadChars: analysis.reductionToolPayloadChars,
      summaryReasons: analysis.summaryReasons,
      handoffReasons: analysis.handoffReasons,
      reductionReasons: analysis.reductionReasons,
      compactionReasons: analysis.compactionReasons,
      locality: {
        source: analysis.locality.source,
        signalCount: analysis.locality.signalCount,
        dominantAction: analysis.locality.dominantAction,
        stablePrefixChars: analysis.locality.stablePrefixChars,
        stablePrefixShare: analysis.locality.stablePrefixShare,
        activeReplayMessageCount: analysis.locality.activeReplayMessageCount,
        activeReplayChars: analysis.locality.activeReplayChars,
        protectedMessageIds: analysis.locality.protectedMessageIds,
        protectedChars: analysis.locality.protectedChars,
        summaryCandidateMessageIds: analysis.locality.summaryCandidateMessageIds,
        summaryCandidateChars: analysis.locality.summaryCandidateChars,
        reductionCandidateMessageIds: analysis.locality.reductionCandidateMessageIds,
        reductionCandidateChars: analysis.locality.reductionCandidateChars,
        handoffCandidateMessageIds: analysis.locality.handoffCandidateMessageIds,
        handoffCandidateChars: analysis.locality.handoffCandidateChars,
        errorCandidateMessageIds: analysis.locality.errorCandidateMessageIds,
        compactionCandidateBranchIds: analysis.locality.compactionCandidateBranchIds,
        compactionCandidateReplayChars: analysis.locality.compactionCandidateReplayChars,
      },
      cacheHealth: {
        supported: analysis.cacheHealth.supported,
        due: analysis.cacheHealth.due,
        planned: analysis.cacheHealth.planned,
        hitFresh: analysis.cacheHealth.hitFresh,
      },
    },
    roi: analysis.roi,
    decisions: {
      summary: {
        enabled: true,
        purpose: "range_summary",
        requested: analysis.requestSummary,
        reasons: analysis.requestSummary ? [...analysis.summaryReasons] : [],
        cooldownActive: analysis.summaryCooldownActive,
        generationMode: analysis.summaryGenerationMode,
        arbitration: analysis.summaryArbitration,
      },
      handoff: {
        enabled: config.handoffEnabled,
        purpose: "task_handoff",
        requested: analysis.requestHandoff,
        reasons: analysis.requestHandoff ? [...analysis.handoffReasons] : [],
        cooldownActive: analysis.handoffCooldownActive,
        generationMode: analysis.handoffGenerationMode,
        arbitration: analysis.handoffArbitration,
      },
      reduction: {
        enabled: config.reductionEnabled,
        beforeCallPassIds: analysis.reductionBeforeCallPassIds,
        afterCallPassIds: analysis.reductionAfterCallPassIds,
        reasons: analysis.reductionReasons,
      },
      compaction: {
        supported: apiFamily === "openai-responses",
        enabled: config.compactionEnabled,
        purpose: "checkpoint_seed",
        requested: analysis.requestCompaction,
        reasons: analysis.requestCompaction ? [...analysis.compactionReasons] : [],
        cooldownActive: analysis.compactionCooldownActive,
        generationMode: analysis.compactionGenerationMode,
        arbitration: analysis.compactionArbitration,
      },
      locality: {
        enabled: config.locality.enabled,
        dominantAction: analysis.locality.dominantAction,
        signalCount: analysis.locality.signalCount,
        protectedMessageIds: analysis.locality.protectedMessageIds,
        summaryCandidateMessageIds: analysis.locality.summaryCandidateMessageIds,
        reductionCandidateMessageIds: analysis.locality.reductionCandidateMessageIds,
        handoffCandidateMessageIds: analysis.locality.handoffCandidateMessageIds,
        errorCandidateMessageIds: analysis.locality.errorCandidateMessageIds,
        compactionCandidateBranchIds: analysis.locality.compactionCandidateBranchIds,
        signals: analysis.locality.signals,
      },
      cacheHealth: {
        enabled: config.cacheHealthEnabled,
        supported: analysis.cacheHealth.supported,
        mode: analysis.cacheHealth.mode,
        due: analysis.cacheHealth.due,
        planned: analysis.cacheHealth.planned,
        promptChars: analysis.promptChars,
        lastCheckAtMs: state.cacheHealth.lastCheckAtMs,
        lastReadTokens: state.cacheHealth.lastReadTokens,
        consecutiveMisses: state.cacheHealth.consecutiveMisses,
        hitFresh: analysis.cacheHealth.hitFresh,
      },
      semantic: analysis.semanticBudget,
    },
  };
}

export function createPolicyModule(cfg: PolicyModuleConfig = {}): RuntimeModule {
  const config = normalizeConfig(cfg);
  const stateBySession = new Map<string, PolicySessionState>();

  return {
    name: "module-policy",
    async beforeBuild(ctx) {
      const metadata =
        ctx.metadata && typeof ctx.metadata === "object"
          ? (ctx.metadata as Record<string, unknown>)
          : undefined;
      if (metadata?.policyBypass === true) {
        return ctx;
      }
      const apiFamily = resolveApiFamily(ctx);
      const state = stateBySession.get(ctx.sessionId) ?? createInitialPolicySessionState();
      const stabilizerEligible = readStabilizerEligible(ctx);
      const analysis = analyzePolicyBeforeBuild(ctx, state, apiFamily, config);
      const policy = buildPolicyMetadata(apiFamily, state, analysis, config, stabilizerEligible);

      let nextCtx: RuntimeTurnContext = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          policy,
        },
      };

      if (policy.decisions.reduction.enabled) {
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_REDUCTION_DECIDED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            beforeCallPassIds: policy.decisions.reduction.beforeCallPassIds,
            afterCallPassIds: policy.decisions.reduction.afterCallPassIds,
            reasons: policy.decisions.reduction.reasons,
            toolPayloadSegmentCount: policy.signals.reductionToolPayloadSegmentCount,
            toolPayloadChars: policy.signals.reductionToolPayloadChars,
            localityReductionChars: policy.signals.locality.reductionCandidateChars,
            roi: policy.roi.reduction,
            apiFamily,
          },
        });
      }

      if (stabilizerEligible && config.cacheHealthEnabled && analysis.cacheHealth.supported) {
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_CACHE_HEALTH_DECIDED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            mode: policy.decisions.cacheHealth.mode,
            due: policy.decisions.cacheHealth.due,
            planned: policy.decisions.cacheHealth.planned,
            promptChars: policy.decisions.cacheHealth.promptChars,
            maxPromptChars: policy.config.cacheHealth.maxPromptChars,
            intervalSeconds: policy.config.cacheHealth.intervalSeconds,
            consecutiveMisses: policy.decisions.cacheHealth.consecutiveMisses,
            hitFresh: policy.decisions.cacheHealth.hitFresh,
            apiFamily,
          },
        });
      }

      if (policy.decisions.compaction.requested) {
        state.lastCompactionRequestTurn = state.completedTurns;
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            reasons: policy.decisions.compaction.reasons,
            cumulativeInputTokens: state.cumulativeInputTokens,
            turn: state.completedTurns,
            candidateReplayChars: policy.signals.locality.compactionCandidateReplayChars,
            candidateBranchIds: policy.signals.locality.compactionCandidateBranchIds,
            roi: policy.roi.compaction,
            purpose: policy.decisions.compaction.purpose,
            generationMode: policy.decisions.compaction.generationMode,
            arbitration: policy.decisions.compaction.arbitration,
            semanticBudget: policy.decisions.semantic,
            apiFamily,
          },
        });
      }

      if (policy.decisions.handoff.requested) {
        state.lastHandoffRequestTurn = state.completedTurns;
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_HANDOFF_REQUESTED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            reasons: policy.decisions.handoff.reasons,
            cumulativeInputTokens: state.cumulativeInputTokens,
            turn: state.completedTurns,
            candidateMessageIds: policy.decisions.locality.handoffCandidateMessageIds,
            candidateChars: policy.signals.locality.handoffCandidateChars,
            roi: policy.roi.handoff,
            purpose: policy.decisions.handoff.purpose,
            generationMode: policy.decisions.handoff.generationMode,
            arbitration: policy.decisions.handoff.arbitration,
            semanticBudget: policy.decisions.semantic,
            apiFamily,
          },
        });
      }

      if (!policy.decisions.summary.requested) {
        stateBySession.set(ctx.sessionId, state);
        return nextCtx;
      }

      state.lastSummaryRequestTurn = state.completedTurns;
      stateBySession.set(ctx.sessionId, state);
      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
        source: "module-policy",
        at: new Date().toISOString(),
        payload: {
          cumulativeInputTokens: state.cumulativeInputTokens,
          stableChars: analysis.stableChars,
          reasons: policy.decisions.summary.reasons,
          candidateMessageIds: policy.decisions.locality.summaryCandidateMessageIds,
          candidateChars: policy.signals.locality.summaryCandidateChars,
          roi: policy.roi.summary,
          purpose: policy.decisions.summary.purpose,
          generationMode: policy.decisions.summary.generationMode,
          arbitration: policy.decisions.summary.arbitration,
          semanticBudget: policy.decisions.semantic,
          apiFamily,
        },
      });
    },
    async afterCall(ctx, result) {
      const metadata =
        ctx.metadata && typeof ctx.metadata === "object"
          ? (ctx.metadata as Record<string, unknown>)
          : undefined;
      if (metadata?.policyBypass === true) {
        return result;
      }
      const apiFamily = resolveApiFamily(ctx);
      const state = stateBySession.get(ctx.sessionId) ?? createInitialPolicySessionState();
      state.completedTurns += 1;

      const rawReadTokens = result.usage?.cacheReadTokens ?? result.usage?.cachedTokens;
      const hasReadSignal = typeof rawReadTokens === "number" && Number.isFinite(rawReadTokens);
      const readTokens = hasReadSignal ? Number(rawReadTokens) : 0;
      state.cumulativeInputTokens += readInputTokens(result.usage);

      if (hasReadSignal) {
        state.recentCacheReadHit.push(readTokens > 0 ? 1 : 0);
        if (state.recentCacheReadHit.length > config.cacheJitterWindowTurns * 3) {
          state.recentCacheReadHit = state.recentCacheReadHit.slice(-config.cacheJitterWindowTurns * 3);
        }
      }
      stateBySession.set(ctx.sessionId, state);

      const policyMeta = readPolicyOnlineMetadata(ctx.metadata);
      const cacheHealthDecision = policyMeta?.decisions.cacheHealth;
      if (
        config.cacheHealthEnabled &&
        cacheHealthDecision?.supported &&
        cacheHealthDecision.planned &&
        hasReadSignal
      ) {
        const nowMs = Date.now();
        const hit = readTokens >= config.cacheHealthHitMinTokens;
        state.cacheHealth.lastCheckAtMs = nowMs;
        state.cacheHealth.lastReadTokens = readTokens;
        if (hit) {
          state.cacheHealth.lastHitAtMs = nowMs;
          state.cacheHealth.consecutiveMisses = 0;
          state.cacheHealth.mode = "warm";
        } else {
          state.cacheHealth.consecutiveMisses += 1;
          state.cacheHealth.mode =
            state.cacheHealth.consecutiveMisses >= config.cacheHealthMissesToCold ? "cold" : "uncertain";
        }
        stateBySession.set(ctx.sessionId, state);
        result = appendResultEvent(result, {
          type: ECOCLAW_EVENT_TYPES.POLICY_CACHE_HEALTH_RESULT,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            planned: true,
            hit,
            readTokens,
            hasReadSignal,
            hitMinTokens: config.cacheHealthHitMinTokens,
            mode: state.cacheHealth.mode,
            consecutiveMisses: state.cacheHealth.consecutiveMisses,
            apiFamily,
          },
        });
      }

      return result;
    },
  };
}
