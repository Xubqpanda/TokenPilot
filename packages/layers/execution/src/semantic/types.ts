import type {
  RuntimeModuleRuntime,
  RuntimeTurnContext,
  UsageSnapshot,
} from "@ecoclaw/kernel";
import type { PromptSource } from "./prompt-loader.js";

export type ConversationRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "context"
  | "other";

export type ConversationBlock = {
  id: string;
  role: ConversationRole;
  text: string;
  source?: string;
  turnIndex?: number;
  at?: string;
  metadata?: Record<string, unknown>;
};

export type SemanticGenerationMode = "heuristic" | "llm_full_context" | "prebuilt";

export type SemanticPromptConfig = {
  inline?: string;
  path?: string;
  fallback: string;
};

export type SemanticGenerationRequest = {
  purpose: string;
  blocks: ConversationBlock[];
  instruction: string;
  heuristicText: string;
  mode: SemanticGenerationMode;
  fallbackToHeuristic: boolean;
  runtime?: RuntimeModuleRuntime;
  runtimeContext?: RuntimeTurnContext;
  provider?: string;
  model?: string;
  maxOutputTokens: number;
  prebuiltText?: string;
  sessionTag?: string;
};

export type SemanticGenerationRoleCounts = Record<ConversationRole, number>;

export type SemanticGenerationMetrics = {
  sourceBlockCount: number;
  sourceChars: number;
  sourceRoleCounts: SemanticGenerationRoleCounts;
  requestPromptChars: number;
  requestSegmentCount: number;
  instructionChars: number;
  sidecarSessionId?: string;
};

export type SemanticGenerationRecord = {
  mode: "heuristic" | "llm_full_context_tail_prompt" | "prebuilt";
  provider: string;
  model: string;
  requestedAt: string;
  completedAt: string;
  usage?: UsageSnapshot;
  error?: string;
  request: SemanticGenerationMetrics;
};

export type SemanticPromptResolution = {
  source: PromptSource;
  path?: string;
  error?: string;
};

export type SemanticGenerationResult = {
  text: string;
  generation: SemanticGenerationRecord;
};
