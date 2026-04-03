import type { ContextSegment, RuntimeTurnContext } from "@ecoclaw/kernel";
import {
  countRoles,
  renderBlocks,
  totalBlockChars,
} from "./helpers.js";
import type {
  ConversationBlock,
  SemanticGenerationRequest,
  SemanticGenerationResult,
} from "./types.js";

function blocksToSegments(blocks: ConversationBlock[]): ContextSegment[] {
  return blocks.map((block, index) => ({
    id: `semantic-${block.id || index + 1}`,
    kind:
      block.role === "system"
        ? "stable"
        : block.role === "tool"
          ? "volatile"
          : "semi_stable",
    text: block.text,
    priority: Math.max(1, blocks.length - index),
    source: block.source ?? `semantic:${block.role}`,
    metadata: block.metadata,
  }));
}

export async function generateSemanticText(
  request: SemanticGenerationRequest,
): Promise<SemanticGenerationResult> {
  const requestedAt = new Date().toISOString();
  const counts = countRoles(request.blocks);
  const sourceChars = totalBlockChars(request.blocks);
  const baseMetrics = {
    sourceBlockCount: request.blocks.length,
    sourceChars,
    sourceRoleCounts: counts,
    requestPromptChars: 0,
    requestSegmentCount: request.blocks.length,
    instructionChars: request.instruction.length,
    sidecarSessionId: undefined,
  };
  const defaultProvider = request.provider ?? request.runtimeContext?.provider ?? "unknown";
  const defaultModel = request.model ?? request.runtimeContext?.model ?? "unknown";

  if (request.mode === "prebuilt") {
    return {
      text: String(request.prebuiltText ?? request.heuristicText ?? "").trim(),
      generation: {
        mode: "prebuilt",
        provider: defaultProvider,
        model: defaultModel,
        requestedAt,
        completedAt: new Date().toISOString(),
        request: baseMetrics,
      },
    };
  }

  if (request.mode === "heuristic") {
    return {
      text: request.heuristicText.trim(),
      generation: {
        mode: "heuristic",
        provider: defaultProvider,
        model: defaultModel,
        requestedAt,
        completedAt: new Date().toISOString(),
        request: baseMetrics,
      },
    };
  }

  if (!request.runtime || !request.runtimeContext) {
    if (!request.fallbackToHeuristic) {
      throw new Error("llm_full_context requires runtime and runtimeContext");
    }
    return {
      text: request.heuristicText.trim(),
      generation: {
        mode: "heuristic",
        provider: defaultProvider,
        model: defaultModel,
        requestedAt,
        completedAt: new Date().toISOString(),
        error: "llm_full_context requires runtime and runtimeContext",
        request: baseMetrics,
      },
    };
  }

  const renderedBlocks = renderBlocks(request.blocks);
  const fullPrompt = [renderedBlocks, "[[REQUEST]]", request.instruction]
    .filter(Boolean)
    .join("\n\n");
  const sidecarSessionId = `${request.runtimeContext.sessionId}::${request.sessionTag ?? request.purpose}`;
  const sidecarCtx: RuntimeTurnContext = {
    ...request.runtimeContext,
    sessionId: sidecarSessionId,
    provider: request.provider ?? request.runtimeContext.provider,
    model: request.model ?? request.runtimeContext.model,
    prompt: fullPrompt,
    segments: [
      ...blocksToSegments(request.blocks),
      {
        id: `semantic-request-${request.purpose}`,
        kind: "volatile",
        text: request.instruction,
        priority: request.blocks.length + 1,
        source: `semantic:${request.purpose}`,
      },
    ],
    budget: {
      maxInputTokens: request.runtimeContext.budget.maxInputTokens,
      reserveOutputTokens: Math.max(128, request.maxOutputTokens),
    },
    metadata: {
      ...(request.runtimeContext.metadata ?? {}),
      semanticRequest: {
        purpose: request.purpose,
        mode: request.mode,
      },
    },
  };

  try {
    const llmResult = await request.runtime.callModel(sidecarCtx);
    const text = String(llmResult.content ?? "").trim();
    if (!text) {
      throw new Error("semantic sidecar returned empty content");
    }
    return {
      text,
      generation: {
        mode: "llm_full_context_tail_prompt",
        provider: sidecarCtx.provider,
        model: sidecarCtx.model,
        requestedAt,
        completedAt: new Date().toISOString(),
        usage: llmResult.usage,
        request: {
          ...baseMetrics,
          requestPromptChars: fullPrompt.length,
          requestSegmentCount: sidecarCtx.segments.length,
          sidecarSessionId,
        },
      },
    };
  } catch (err) {
    if (!request.fallbackToHeuristic) throw err;
    return {
      text: request.heuristicText.trim(),
      generation: {
        mode: "heuristic",
        provider: defaultProvider,
        model: defaultModel,
        requestedAt,
        completedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
        request: {
          ...baseMetrics,
          requestPromptChars: fullPrompt.length,
          requestSegmentCount: request.blocks.length + 1,
          sidecarSessionId,
        },
      },
    };
  }
}
