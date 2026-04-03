import type {
  ContextSegment,
  RuntimeTurnContext,
  RuntimeTurnResult,
} from "@ecoclaw/kernel";
import type {
  ConversationBlock,
  ConversationRole,
  SemanticGenerationRoleCounts,
} from "./types.js";

export const clipText = (value: unknown, maxChars: number): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
};

export const uniqueNonEmpty = (items: string[], maxItems: number): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = clipText(item, 320);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
};

const emptyRoleCounts = (): SemanticGenerationRoleCounts => ({
  system: 0,
  user: 0,
  assistant: 0,
  tool: 0,
  context: 0,
  other: 0,
});

export const countRoles = (blocks: ConversationBlock[]): SemanticGenerationRoleCounts => {
  const counts = emptyRoleCounts();
  for (const block of blocks) {
    counts[block.role] += 1;
  }
  return counts;
};

export const totalBlockChars = (blocks: ConversationBlock[]): number =>
  blocks.reduce((sum, block) => sum + block.text.length, 0);

export const renderBlocks = (blocks: ConversationBlock[]): string =>
  blocks
    .map((block, index) => {
      const header = [
        `BLOCK ${index + 1}`,
        `role=${block.role}`,
        block.source ? `source=${block.source}` : "",
        block.turnIndex != null ? `turn=${block.turnIndex}` : "",
        block.at ? `at=${block.at}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      return `[[${header}]]\n${block.text}`;
    })
    .join("\n\n");

export const latestBlockByRole = (
  blocks: ConversationBlock[],
  role: ConversationRole,
): ConversationBlock | undefined => {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.role === role) return blocks[index];
  }
  return undefined;
};

function inferRoleFromSegment(segment: ContextSegment): ConversationRole {
  const metadata =
    segment.metadata && typeof segment.metadata === "object"
      ? (segment.metadata as Record<string, unknown>)
      : undefined;
  const explicitRole = typeof metadata?.role === "string" ? metadata.role.toLowerCase() : "";
  if (
    explicitRole === "system" ||
    explicitRole === "user" ||
    explicitRole === "assistant" ||
    explicitRole === "tool"
  ) {
    return explicitRole;
  }

  const hint = `${segment.source ?? ""} ${segment.id}`.toLowerCase();
  if (/\buser\b/.test(hint)) return "user";
  if (/\bassistant\b/.test(hint)) return "assistant";
  if (/\btool\b|\bobservation\b/.test(hint)) return "tool";
  if (segment.kind === "stable") return "system";
  return "context";
}

export const contextToConversationBlocks = (params: {
  ctx: RuntimeTurnContext;
  result?: RuntimeTurnResult;
  includeAssistantReply?: boolean;
}): ConversationBlock[] => {
  const { ctx, result, includeAssistantReply = true } = params;
  const blocks = ctx.segments.map((segment, index) => ({
    id: segment.id,
    role: inferRoleFromSegment(segment),
    text: segment.text,
    source: segment.source,
    metadata: segment.metadata,
    turnIndex: index + 1,
  } satisfies ConversationBlock));

  if (includeAssistantReply) {
    const assistantText = String(result?.content ?? "").trim();
    if (assistantText) {
      blocks.push({
        id: "latest-assistant-reply",
        role: "assistant",
        text: assistantText,
        source: "module-output",
        metadata: undefined,
        turnIndex: blocks.length + 1,
      });
    }
  }

  return blocks;
};
