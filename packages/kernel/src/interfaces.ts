import type { RuntimeTurnContext, RuntimeTurnResult, UsageSnapshot } from "./types.js";

export type RuntimeModule = {
  name: string;
  beforeBuild?(ctx: RuntimeTurnContext): Promise<RuntimeTurnContext>;
  beforeCall?(ctx: RuntimeTurnContext): Promise<RuntimeTurnContext>;
  afterCall?(ctx: RuntimeTurnContext, result: RuntimeTurnResult): Promise<RuntimeTurnResult>;
};

export type ProviderAdapter = {
  provider: string;
  annotatePrompt(ctx: RuntimeTurnContext): Promise<RuntimeTurnContext>;
  normalizeUsage(raw: unknown): UsageSnapshot;
};

export type PromptProfileManager = {
  getActiveProfile(sessionId: string): Promise<string>;
  bumpProfileVersion(sessionId: string, reason: string): Promise<void>;
};

export type MemoryGraph = {
  // Reserved for cross-session memory/retrieval in later milestones.
  queryRelated(sessionId: string, query: string): Promise<Array<{ sessionId: string; summary: string }>>;
};

export type MetricsSink = {
  emit(event: string, payload: Record<string, unknown>): Promise<void>;
};
