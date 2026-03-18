export type SessionMode = "single" | "cross";

export type ContextSegment = {
  id: string;
  kind: "stable" | "semi_stable" | "volatile";
  text: string;
  priority: number;
  source?: string;
};

export type RuntimeBudget = {
  maxInputTokens: number;
  reserveOutputTokens: number;
};

export type UsageSnapshot = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cachedTokens?: number;
  cacheHitTokens?: number;
  cacheHitRate?: number;
  providerRaw?: unknown;
};

export type RuntimeTurnTraceStep = {
  stage: "beforeBuild" | "annotatePrompt" | "beforeCall" | "afterCall";
  module: string;
  promptChars: number;
  segmentCount: number;
  responseChars?: number;
  timestamp: string;
};

export type RuntimeTurnTrace = {
  initialContext: RuntimeTurnContext;
  finalContext: RuntimeTurnContext;
  moduleSteps: RuntimeTurnTraceStep[];
  scheduling?: {
    scheduler?: string;
    scheduleId: string;
    reason?: string;
    metadata?: Record<string, unknown>;
    availableModules: string[];
    activeModules: string[];
  };
  usageRaw?: unknown;
  usageNormalized?: UsageSnapshot;
  responsePreview: string;
};

export type RuntimeTurnContext = {
  sessionId: string;
  sessionMode: SessionMode;
  provider: string;
  model: string;
  prompt: string;
  segments: ContextSegment[];
  budget: RuntimeBudget;
  metadata?: Record<string, unknown>;
};

export type RuntimeTurnResult = {
  content: string;
  usage?: UsageSnapshot;
  metadata?: Record<string, unknown>;
};

export type PersistedTurnRecord = {
  turnId: string;
  sessionId: string;
  provider: string;
  model: string;
  prompt: string;
  segments: ContextSegment[];
  usage?: UsageSnapshot;
  responsePreview: string;
  response?: string;
  trace?: RuntimeTurnTrace;
  resultMetadata?: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
  status: "ok" | "error";
  error?: string;
};

export type PersistedSessionMeta = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  lastStatus?: "ok" | "error";
  turnCount: number;
};
