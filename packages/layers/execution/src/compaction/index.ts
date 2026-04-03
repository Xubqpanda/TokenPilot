import {
  ECOCLAW_EVENT_TYPES,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeModule,
  type RuntimeModuleRuntime,
  type RuntimeTurnContext,
} from "@ecoclaw/kernel";
import {
  clipText,
  contextToConversationBlocks,
  countRoles,
  generateSemanticText,
  latestBlockByRole,
  totalBlockChars,
  uniqueNonEmpty,
  type ConversationBlock,
  type SemanticGenerationMode,
} from "../semantic/index.js";
import { buildCompactionPlan } from "./plan-builder.js";
import {
  resolveCompactionPrompt,
  resolveResumePrefixPrompt,
} from "./prompt-loader.js";
import type {
  CompactionArtifact,
  CompactionModuleConfig,
  RecentMessage,
} from "./types.js";

export * from "./types.js";
export * from "./plan-builder.js";
export * from "./strategy-registry.js";
export * from "./strategy-summary-then-fork.js";

function buildRecentMessages(blocks: ConversationBlock[]): RecentMessage[] {
  const userAssistant = blocks.filter(
    (block) => block.role === "user" || block.role === "assistant",
  );
  const recent = userAssistant.slice(-6);
  return recent.map((block, index) => ({
    index: index + 1,
    at: block.at,
    user: block.role === "user" ? clipText(block.text, 240) : undefined,
    assistant: block.role === "assistant" ? clipText(block.text, 240) : undefined,
  }));
}

export function buildHeuristicCompactionText(blocks: ConversationBlock[]): string {
  const latestUser = clipText(latestBlockByRole(blocks, "user")?.text, 260) || "(none)";
  const latestAssistant =
    clipText(latestBlockByRole(blocks, "assistant")?.text, 260) || "(none)";
  const systemHighlights = uniqueNonEmpty(
    blocks
      .filter((block) => block.role === "system" || block.role === "context")
      .slice(-4)
      .map((block) => clipText(block.text, 220)),
    4,
  );
  const toolHighlights = uniqueNonEmpty(
    blocks
      .filter((block) => block.role === "tool")
      .slice(-3)
      .map((block) => clipText(block.text, 220)),
    3,
  );

  return [
    "## Current Progress",
    `- Latest user intent: ${latestUser}`,
    `- Latest assistant state: ${latestAssistant}`,
    "",
    "## Important Context",
    ...(systemHighlights.length > 0
      ? systemHighlights.map((item) => `- ${item}`)
      : ["- (none)"]),
    "",
    "## Tool Findings",
    ...(toolHighlights.length > 0 ? toolHighlights.map((item) => `- ${item}`) : ["- (none)"]),
    "",
    "## Next Steps",
    `- Continue from the latest user intent: ${latestUser}`,
    latestAssistant !== "(none)"
      ? `- Preserve the latest assistant progress: ${latestAssistant}`
      : "- Re-establish the current task state before proceeding.",
  ].join("\n");
}

function resolveCompactionGenerationMode(
  ctx: RuntimeTurnContext,
  fallback: "llm_full_context" | "heuristic",
): "llm_full_context" | "heuristic" {
  const policy =
    ctx.metadata?.policy && typeof ctx.metadata.policy === "object"
      ? (ctx.metadata.policy as Record<string, unknown>)
      : undefined;
  const decisions =
    policy?.decisions && typeof policy.decisions === "object"
      ? (policy.decisions as Record<string, unknown>)
      : undefined;
  const compaction =
    decisions?.compaction && typeof decisions.compaction === "object"
      ? (decisions.compaction as Record<string, unknown>)
      : undefined;
  const mode = compaction?.generationMode;
  return mode === "heuristic" || mode === "llm_full_context" ? mode : fallback;
}

function normalizeCompactionGenerationMode(
  mode: SemanticGenerationMode | undefined,
): "llm_full_context" | "heuristic" {
  return mode === "llm_full_context" ? "llm_full_context" : "heuristic";
}

function buildCompactionInstruction(promptText: string, blocks: ConversationBlock[], triggerSources: string[]): string {
  const triggerLine = triggerSources.length > 0 ? triggerSources.join(", ") : "manual";
  return [
    promptText,
    "",
    `Selected block count: ${blocks.length}`,
    `Selected character count: ${totalBlockChars(blocks)}`,
    `Trigger sources: ${triggerLine}`,
    "Return a self-contained checkpoint summary for later continuation.",
  ].join("\n");
}

export async function generateCompactionArtifact(params: {
  blocks: ConversationBlock[];
  requestedByPolicy?: boolean;
  triggerSources?: string[];
  cfg?: CompactionModuleConfig;
  runtime?: RuntimeModuleRuntime;
  runtimeContext?: RuntimeTurnContext;
}): Promise<CompactionArtifact> {
  const {
    blocks,
    requestedByPolicy = false,
    triggerSources = [],
    cfg = {},
    runtime,
    runtimeContext,
  } = params;
  const resolvedCompactionPrompt = await resolveCompactionPrompt({
    inline: cfg.compactionPrompt,
    path: cfg.compactionPromptPath,
  });
  const resolvedResumePrefixPrompt = await resolveResumePrefixPrompt({
    inline: cfg.resumePrefixPrompt,
    path: cfg.resumePrefixPromptPath,
  });
  const heuristicText = buildHeuristicCompactionText(blocks);
  const semantic = await generateSemanticText({
    purpose: "compaction-checkpoint",
    blocks,
    instruction: buildCompactionInstruction(resolvedCompactionPrompt.text, blocks, triggerSources),
    heuristicText,
    mode: cfg.generationMode ?? "heuristic",
    fallbackToHeuristic: cfg.fallbackToHeuristic ?? true,
    runtime,
    runtimeContext,
    provider: cfg.compactionProvider,
    model: cfg.compactionModel,
    maxOutputTokens: Math.max(128, cfg.compactionMaxOutputTokens ?? 1200),
    sessionTag: "compaction-sidecar",
  });
  const summaryText = semantic.text;
  const resumePrefixPrompt = resolvedResumePrefixPrompt.text;
  const seedSummary = [resumePrefixPrompt, summaryText].filter(Boolean).join("\n\n");

  return {
    schemaVersion: 1,
    compactionId: `compaction-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    kind: "checkpoint_seed",
    requestedByPolicy,
    triggerSources,
    strategy: "summary_then_fork",
    sourceBlockIds: blocks.map((block) => block.id),
    stats: {
      sourceBlockCount: blocks.length,
      sourceChars: totalBlockChars(blocks),
      roleCounts: countRoles(blocks),
    },
    recentMessages: buildRecentMessages(blocks),
    summaryText,
    resumePrefixPrompt,
    seedSummary,
    promptConfig: {
      compactionPromptSource: resolvedCompactionPrompt.source,
      compactionPromptPath: resolvedCompactionPrompt.path,
      compactionPromptError: resolvedCompactionPrompt.error,
      resumePrefixPromptSource: resolvedResumePrefixPrompt.source,
      resumePrefixPromptPath: resolvedResumePrefixPrompt.path,
      resumePrefixPromptError: resolvedResumePrefixPrompt.error,
    },
    generation: semantic.generation,
  };
}

function readTriggerSources(ctx: RuntimeTurnContext): string[] {
  const requests = findRuntimeEventsByType(
    ctx.metadata,
    ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED,
  );
  return uniqueNonEmpty(
    requests.flatMap((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const reasons = Array.isArray(payload.reasons)
        ? payload.reasons.map((item) => String(item ?? ""))
        : [];
      return [event.source, ...reasons];
    }),
    8,
  );
}

export function createCompactionModule(cfg: CompactionModuleConfig = {}): RuntimeModule {
  const strategy = cfg.strategy ?? "summary_then_fork";

  return {
    name: "module-compaction",
    async afterCall(ctx, result, runtime) {
      const policyEvents = findRuntimeEventsByType(
        ctx.metadata,
        ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED,
      );
      if (policyEvents.length === 0) return result;

      const triggerSources = readTriggerSources(ctx);
      const generationMode = resolveCompactionGenerationMode(
        ctx,
        normalizeCompactionGenerationMode(cfg.generationMode),
      );
      const blocks = contextToConversationBlocks({
        ctx,
        result,
        includeAssistantReply: cfg.includeAssistantReply ?? true,
      });
      const artifact = await generateCompactionArtifact({
        blocks,
        requestedByPolicy: true,
        triggerSources,
        cfg: {
          ...cfg,
          generationMode,
        },
        runtime,
        runtimeContext: ctx,
      });
      const createdAt = new Date().toISOString();
      const latestPolicyEvent = policyEvents[policyEvents.length - 1];
      const triggerPayload = (latestPolicyEvent?.payload ?? {}) as Record<string, unknown>;
      const plan = buildCompactionPlan({
        strategy,
        strategies: cfg.strategies,
        artifact,
        triggerReasons: triggerPayload.reasons,
        createdAt,
      });
      if (!plan) return result;

      return appendResultEvent(
        {
          ...result,
          metadata: {
            ...(result.metadata ?? {}),
            compaction: {
              requestedByPolicy: true,
              triggerSources,
              artifact,
              plan,
            },
            compactionPlan: plan,
          },
        },
        {
          type: ECOCLAW_EVENT_TYPES.COMPACTION_PLAN_GENERATED,
          source: "module-compaction",
          at: createdAt,
          payload: plan,
        },
      );
    },
  };
}
