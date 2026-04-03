import type {
  PersistedBranchRecord,
  PersistedMessageRecord,
  PersistedSessionMeta,
  PersistedTurnRecord,
  RuntimeTurnContext,
  RuntimeTurnResult,
  UsageSnapshot,
} from "./types.js";

export type RuntimeModuleRuntime = {
  callModel(
    ctx: RuntimeTurnContext,
    options?: {
      annotatePrompt?: boolean;
      normalizeUsage?: boolean;
    },
  ): Promise<RuntimeTurnResult>;
};

export type RuntimeModule = {
  name: string;
  beforeBuild?(ctx: RuntimeTurnContext, runtime: RuntimeModuleRuntime): Promise<RuntimeTurnContext>;
  beforeCall?(ctx: RuntimeTurnContext, runtime: RuntimeModuleRuntime): Promise<RuntimeTurnContext>;
  afterCall?(
    ctx: RuntimeTurnContext,
    result: RuntimeTurnResult,
    runtime: RuntimeModuleRuntime,
  ): Promise<RuntimeTurnResult>;
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
  appendBranch(record: PersistedBranchRecord): Promise<void>;
  appendMessages(records: PersistedMessageRecord[]): Promise<void>;
  upsertSessionMeta(sessionId: string, update: Partial<PersistedSessionMeta>): Promise<PersistedSessionMeta>;
  readSessionMeta(sessionId: string): Promise<PersistedSessionMeta | null>;
  listTurns(sessionId: string): Promise<PersistedTurnRecord[]>;
  listBranches(sessionId: string): Promise<PersistedBranchRecord[]>;
  listMessages(
    sessionId: string,
    options?: { branchId?: string },
  ): Promise<PersistedMessageRecord[]>;
  writeSummary(sessionId: string, summary: string, source: string): Promise<void>;
};
