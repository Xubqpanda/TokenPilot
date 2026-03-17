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
  providerRaw?: unknown;
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
