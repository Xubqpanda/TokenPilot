import {
  ECOCLAW_EVENT_TYPES,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeModule,
  type RuntimeModuleRuntime,
  type RuntimeTurnContext,
  type RuntimeTurnResult,
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
  type SemanticGenerationRecord,
  type SemanticGenerationRoleCounts,
  type SemanticPromptResolution,
} from "../semantic/index.js";
import { resolveSummaryPrompt } from "./prompt-loader.js";

export type SummaryModuleConfig = {
  generationMode?: SemanticGenerationMode;
  fallbackToHeuristic?: boolean;
  summaryProvider?: string;
  summaryModel?: string;
  summaryMaxOutputTokens?: number;
  includeAssistantReply?: boolean;
  summaryPrompt?: string;
  summaryPromptPath?: string;
};

export type SummaryRequest = {
  blocks: ConversationBlock[];
  requestedByPolicy?: boolean;
  triggerSources?: string[];
  scopeLabel?: string;
};

export type SummaryArtifact = {
  schemaVersion: 1;
  summaryId: string;
  generatedAt: string;
  kind: "range_summary";
  requestedByPolicy: boolean;
  triggerSources: string[];
  scopeLabel?: string;
  sourceBlockIds: string[];
  stats: {
    sourceBlockCount: number;
    sourceChars: number;
    roleCounts: SemanticGenerationRoleCounts;
  };
  latestUserIntent: string;
  latestAssistantState: string;
  summaryText: string;
  promptConfig: {
    summaryPromptSource: SemanticPromptResolution["source"];
    summaryPromptPath?: string;
    summaryPromptError?: string;
  };
  generation: SemanticGenerationRecord;
};

export function buildHeuristicSummaryText(blocks: ConversationBlock[]): string {
  const counts = countRoles(blocks);
  const latestUser = clipText(latestBlockByRole(blocks, "user")?.text, 220) || "(none)";
  const latestAssistant =
    clipText(latestBlockByRole(blocks, "assistant")?.text, 220) || "(none)";
  const highlights = uniqueNonEmpty(
    blocks.slice(-6).map((block) => `${block.role}: ${clipText(block.text, 220)}`),
    6,
  );

  return [
    `Range summary for ${blocks.length} selected blocks.`,
    "",
    `- Coverage: user=${counts.user}, assistant=${counts.assistant}, tool=${counts.tool}, system=${counts.system}, context=${counts.context}`,
    `- Latest user intent: ${latestUser}`,
    `- Latest assistant state: ${latestAssistant}`,
    "",
    "Key points:",
    ...(highlights.length > 0 ? highlights.map((item) => `- ${item}`) : ["- (none)"]),
  ].join("\n");
}

function resolveSummaryGenerationMode(
  ctx: RuntimeTurnContext,
  fallback: SemanticGenerationMode,
): SemanticGenerationMode {
  const policy =
    ctx.metadata?.policy && typeof ctx.metadata.policy === "object"
      ? (ctx.metadata.policy as Record<string, unknown>)
      : undefined;
  const decisions =
    policy?.decisions && typeof policy.decisions === "object"
      ? (policy.decisions as Record<string, unknown>)
      : undefined;
  const summary =
    decisions?.summary && typeof decisions.summary === "object"
      ? (decisions.summary as Record<string, unknown>)
      : undefined;
  const mode = summary?.generationMode;
  return mode === "heuristic" || mode === "llm_full_context" ? mode : fallback;
}

function buildSummaryInstruction(promptText: string, blocks: ConversationBlock[]): string {
  return [
    promptText,
    "",
    `Selected block count: ${blocks.length}`,
    `Selected character count: ${totalBlockChars(blocks)}`,
    "Return a concise summary that only covers the selected blocks.",
  ].join("\n");
}

export async function generateSummaryArtifact(params: {
  request: SummaryRequest;
  cfg?: SummaryModuleConfig;
  runtime?: RuntimeModuleRuntime;
  runtimeContext?: RuntimeTurnContext;
}): Promise<SummaryArtifact> {
  const { request, cfg = {}, runtime, runtimeContext } = params;
  const blocks = request.blocks;
  const resolvedPrompt = await resolveSummaryPrompt({
    inline: cfg.summaryPrompt,
    path: cfg.summaryPromptPath,
  });
  const heuristicText = buildHeuristicSummaryText(blocks);
  const latestUserIntent = clipText(latestBlockByRole(blocks, "user")?.text, 280);
  const latestAssistantState = clipText(latestBlockByRole(blocks, "assistant")?.text, 280);
  const semantic = await generateSemanticText({
    purpose: "summary-range",
    blocks,
    instruction: buildSummaryInstruction(resolvedPrompt.text, blocks),
    heuristicText,
    mode: cfg.generationMode ?? "heuristic",
    fallbackToHeuristic: cfg.fallbackToHeuristic ?? true,
    runtime,
    runtimeContext,
    provider: cfg.summaryProvider,
    model: cfg.summaryModel,
    maxOutputTokens: Math.max(128, cfg.summaryMaxOutputTokens ?? 900),
    sessionTag: "summary-sidecar",
  });

  return {
    schemaVersion: 1,
    summaryId: `summary-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    kind: "range_summary",
    requestedByPolicy: request.requestedByPolicy === true,
    triggerSources: request.triggerSources ?? [],
    scopeLabel: request.scopeLabel,
    sourceBlockIds: blocks.map((block) => block.id),
    stats: {
      sourceBlockCount: blocks.length,
      sourceChars: totalBlockChars(blocks),
      roleCounts: countRoles(blocks),
    },
    latestUserIntent,
    latestAssistantState,
    summaryText: semantic.text,
    promptConfig: {
      summaryPromptSource: resolvedPrompt.source,
      summaryPromptPath: resolvedPrompt.path,
      summaryPromptError: resolvedPrompt.error,
    },
    generation: semantic.generation,
  };
}

function readTriggerSources(ctx: RuntimeTurnContext): string[] {
  const summaryRequests = findRuntimeEventsByType(
    ctx.metadata,
    ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
  );
  return uniqueNonEmpty(
    summaryRequests.flatMap((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const reasons = Array.isArray(payload.reasons)
        ? payload.reasons.map((item) => String(item ?? ""))
        : [];
      return [event.source, ...reasons];
    }),
    8,
  );
}

export function createSummaryModule(cfg: SummaryModuleConfig = {}): RuntimeModule {
  return {
    name: "module-summary",
    async afterCall(ctx, result, runtime) {
      const requests = findRuntimeEventsByType(
        ctx.metadata,
        ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
      );
      const requested = requests.length > 0;
      const triggerSources = readTriggerSources(ctx);
      const idleResult = {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          summary: {
            requestedByPolicy: requested,
            triggerSources,
            generationMode: cfg.generationMode ?? "heuristic",
          },
        },
      };
      if (!requested) return idleResult;

      const generationMode = resolveSummaryGenerationMode(
        ctx,
        cfg.generationMode ?? "heuristic",
      );
      const blocks = contextToConversationBlocks({
        ctx,
        result,
        includeAssistantReply: cfg.includeAssistantReply ?? true,
      });
      const artifact = await generateSummaryArtifact({
        request: {
          blocks,
          requestedByPolicy: true,
          triggerSources,
          scopeLabel: "current_context",
        },
        cfg: {
          ...cfg,
          generationMode,
        },
        runtime,
        runtimeContext: ctx,
      });

      const nextResult = {
        ...idleResult,
        metadata: {
          ...(idleResult.metadata ?? {}),
          summary: {
            requestedByPolicy: true,
            triggerSources,
            generationMode: artifact.generation.mode,
            artifact,
          },
        },
      };
      return appendResultEvent(nextResult, {
        type: ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED,
        source: "module-summary",
        at: artifact.generatedAt,
        payload: { artifact },
      });
    },
  };
}
