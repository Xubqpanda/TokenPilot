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
  type SemanticGenerationRecord,
  type SemanticGenerationRoleCounts,
  type SemanticPromptResolution,
} from "../semantic/index.js";
import { resolveHandoffPrompt } from "./prompt-loader.js";

export type HandoffModuleConfig = {
  generationMode?: SemanticGenerationMode;
  fallbackToHeuristic?: boolean;
  handoffProvider?: string;
  handoffModel?: string;
  handoffMaxOutputTokens?: number;
  includeAssistantReply?: boolean;
  handoffPrompt?: string;
  handoffPromptPath?: string;
  triggerEventType?: string;
};

export type HandoffArtifact = {
  schemaVersion: 1;
  handoffId: string;
  generatedAt: string;
  kind: "task_handoff";
  triggerSources: string[];
  sourceBlockIds: string[];
  stats: {
    sourceBlockCount: number;
    sourceChars: number;
    roleCounts: SemanticGenerationRoleCounts;
  };
  summaryText: string;
  promptConfig: {
    handoffPromptSource: SemanticPromptResolution["source"];
    handoffPromptPath?: string;
    handoffPromptError?: string;
  };
  generation: SemanticGenerationRecord;
};

function buildHeuristicHandoffText(blocks: ConversationBlock[]): string {
  const latestUser = clipText(latestBlockByRole(blocks, "user")?.text, 260) || "(none)";
  const latestAssistant =
    clipText(latestBlockByRole(blocks, "assistant")?.text, 260) || "(none)";
  const constraints = uniqueNonEmpty(
    blocks
      .filter((block) => block.role === "system" || block.role === "context")
      .slice(-4)
      .map((block) => clipText(block.text, 220)),
    4,
  );
  const toolFacts = uniqueNonEmpty(
    blocks
      .filter((block) => block.role === "tool")
      .slice(-3)
      .map((block) => clipText(block.text, 220)),
    3,
  );

  return [
    "## Progress",
    `- Latest user intent: ${latestUser}`,
    `- Latest assistant state: ${latestAssistant}`,
    "",
    "## Constraints",
    ...(constraints.length > 0 ? constraints.map((item) => `- ${item}`) : ["- (none)"]),
    "",
    "## Critical Facts",
    ...(toolFacts.length > 0 ? toolFacts.map((item) => `- ${item}`) : ["- (none)"]),
    "",
    "## Next Actions",
    `- Continue from: ${latestUser}`,
    latestAssistant !== "(none)"
      ? `- Preserve latest progress: ${latestAssistant}`
      : "- Reconstruct current state before proceeding.",
  ].join("\n");
}

function resolveHandoffGenerationMode(
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
  const handoff =
    decisions?.handoff && typeof decisions.handoff === "object"
      ? (decisions.handoff as Record<string, unknown>)
      : undefined;
  const mode = handoff?.generationMode;
  return mode === "heuristic" || mode === "llm_full_context" ? mode : fallback;
}

function buildHandoffInstruction(promptText: string, blocks: ConversationBlock[]): string {
  return [
    promptText,
    "",
    `Selected block count: ${blocks.length}`,
    `Selected character count: ${totalBlockChars(blocks)}`,
    "Return a concise operational handoff.",
  ].join("\n");
}

export async function generateHandoffArtifact(params: {
  blocks: ConversationBlock[];
  triggerSources?: string[];
  cfg?: HandoffModuleConfig;
  runtime?: RuntimeModuleRuntime;
  runtimeContext?: RuntimeTurnContext;
}): Promise<HandoffArtifact> {
  const { blocks, triggerSources = [], cfg = {}, runtime, runtimeContext } = params;
  const resolvedPrompt = await resolveHandoffPrompt({
    inline: cfg.handoffPrompt,
    path: cfg.handoffPromptPath,
  });
  const semantic = await generateSemanticText({
    purpose: "task-handoff",
    blocks,
    instruction: buildHandoffInstruction(resolvedPrompt.text, blocks),
    heuristicText: buildHeuristicHandoffText(blocks),
    mode: cfg.generationMode ?? "heuristic",
    fallbackToHeuristic: cfg.fallbackToHeuristic ?? true,
    runtime,
    runtimeContext,
    provider: cfg.handoffProvider,
    model: cfg.handoffModel,
    maxOutputTokens: Math.max(128, cfg.handoffMaxOutputTokens ?? 900),
    sessionTag: "handoff-sidecar",
  });

  return {
    schemaVersion: 1,
    handoffId: `handoff-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    kind: "task_handoff",
    triggerSources,
    sourceBlockIds: blocks.map((block) => block.id),
    stats: {
      sourceBlockCount: blocks.length,
      sourceChars: totalBlockChars(blocks),
      roleCounts: countRoles(blocks),
    },
    summaryText: semantic.text,
    promptConfig: {
      handoffPromptSource: resolvedPrompt.source,
      handoffPromptPath: resolvedPrompt.path,
      handoffPromptError: resolvedPrompt.error,
    },
    generation: semantic.generation,
  };
}

export function createHandoffModule(cfg: HandoffModuleConfig = {}): RuntimeModule {
  const triggerEventType = cfg.triggerEventType ?? ECOCLAW_EVENT_TYPES.HANDOFF_REQUESTED;
  return {
    name: "module-handoff",
    async afterCall(ctx, result, runtime) {
      const requests = findRuntimeEventsByType(ctx.metadata, triggerEventType);
      if (requests.length === 0) return result;
      const triggerSources = uniqueNonEmpty(requests.map((event) => event.source), 8);
      const blocks = contextToConversationBlocks({
        ctx,
        result,
        includeAssistantReply: cfg.includeAssistantReply ?? true,
      });
      const generationMode = resolveHandoffGenerationMode(
        ctx,
        cfg.generationMode ?? "heuristic",
      );
      const artifact = await generateHandoffArtifact({
        blocks,
        triggerSources,
        cfg: {
          ...cfg,
          generationMode,
        },
        runtime,
        runtimeContext: ctx,
      });
      return appendResultEvent(
        {
          ...result,
          metadata: {
            ...(result.metadata ?? {}),
            handoff: {
              triggerSources,
              artifact,
            },
          },
        },
        {
          type: ECOCLAW_EVENT_TYPES.HANDOFF_GENERATED,
          source: "module-handoff",
          at: artifact.generatedAt,
          payload: { artifact },
        },
      );
    },
  };
}
