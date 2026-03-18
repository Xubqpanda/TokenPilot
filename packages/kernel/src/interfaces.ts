import type {
  PersistedSessionMeta,
  PersistedTurnRecord,
  RuntimeTurnContext,
  RuntimeTurnResult,
  UsageSnapshot,
} from "./types.js";

export type RuntimeModule = {
  name: string;
  beforeBuild?(ctx: RuntimeTurnContext): Promise<RuntimeTurnContext>;
  beforeCall?(ctx: RuntimeTurnContext): Promise<RuntimeTurnContext>;
  afterCall?(ctx: RuntimeTurnContext, result: RuntimeTurnResult): Promise<RuntimeTurnResult>;
};

export type ModuleScheduleDecision = {
  modules: RuntimeModule[];
  scheduleId: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type ModuleScheduler = {
  name: string;
  selectModules(
    ctx: RuntimeTurnContext,
    availableModules: RuntimeModule[],
  ): Promise<ModuleScheduleDecision>;
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

export type RuntimeStateStore = {
  appendTurn(record: PersistedTurnRecord): Promise<void>;
  upsertSessionMeta(sessionId: string, update: Partial<PersistedSessionMeta>): Promise<PersistedSessionMeta>;
  writeSummary(sessionId: string, summary: string, source: string): Promise<void>;
};
