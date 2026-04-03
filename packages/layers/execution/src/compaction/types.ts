import type {
  SemanticGenerationMode,
  SemanticGenerationRecord,
  SemanticGenerationRoleCounts,
  SemanticPromptResolution,
} from "../semantic/index.js";

export type RecentMessage = {
  index?: number;
  at?: string;
  user?: string;
  assistant?: string;
};

export type CompactionStrategy = "summary_then_fork";

export type CompactionSeedMode = "summary";

export type CompactionArtifact = {
  schemaVersion: 1;
  compactionId: string;
  generatedAt: string;
  kind: "checkpoint_seed";
  requestedByPolicy: boolean;
  triggerSources: string[];
  strategy: CompactionStrategy;
  sourceBlockIds: string[];
  stats: {
    sourceBlockCount: number;
    sourceChars: number;
    roleCounts: SemanticGenerationRoleCounts;
  };
  recentMessages: RecentMessage[];
  summaryText: string;
  resumePrefixPrompt: string;
  seedSummary: string;
  promptConfig: {
    compactionPromptSource: SemanticPromptResolution["source"];
    compactionPromptPath?: string;
    compactionPromptError?: string;
    resumePrefixPromptSource: SemanticPromptResolution["source"];
    resumePrefixPromptPath?: string;
    resumePrefixPromptError?: string;
  };
  generation: SemanticGenerationRecord;
};

export type CompactionPlan = {
  schemaVersion: 1;
  planId: string;
  createdAt: string;
  strategy: CompactionStrategy;
  targetBranch: string;
  seedMode: CompactionSeedMode;
  compactionId?: string;
  summaryText: string;
  summaryChars: number;
  resumePrefixPrompt: string;
  recentMessages: RecentMessage[];
  seedSummary: string;
  triggerReasons: string[];
};

export type CompactionModuleConfig = {
  strategy?: CompactionStrategy;
  strategies?: CompactionStrategyRegistry;
  generationMode?: SemanticGenerationMode;
  fallbackToHeuristic?: boolean;
  compactionProvider?: string;
  compactionModel?: string;
  compactionMaxOutputTokens?: number;
  includeAssistantReply?: boolean;
  compactionPrompt?: string;
  compactionPromptPath?: string;
  resumePrefixPrompt?: string;
  resumePrefixPromptPath?: string;
};

export type CompactionStrategyContext = {
  artifact: Partial<CompactionArtifact>;
  triggerReasons: unknown;
  createdAt?: string;
  idFactory?: () => number;
};

export type CompactionPlanBuilder = (
  params: CompactionStrategyContext,
) => CompactionPlan | null;

export type CompactionStrategyRegistry = Partial<
  Record<CompactionStrategy, CompactionPlanBuilder>
>;
