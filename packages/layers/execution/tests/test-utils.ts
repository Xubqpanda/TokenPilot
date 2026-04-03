import type {
  RuntimeModuleRuntime,
  RuntimeTurnContext,
  RuntimeTurnResult,
} from "@ecoclaw/kernel";

export function createTurnContext(
  overrides: Partial<RuntimeTurnContext> = {},
): RuntimeTurnContext {
  return {
    sessionId: "session-1",
    sessionMode: "single",
    provider: "openai",
    model: "gpt-test",
    apiFamily: "openai-responses",
    prompt: "help me debug the issue",
    segments: [
      {
        id: "system-1",
        kind: "stable",
        text: "You are a helpful agent with access to the repo.",
        priority: 10,
        source: "system",
      },
      {
        id: "user-1",
        kind: "volatile",
        text: "Please inspect the failure and tell me what changed.",
        priority: 5,
        source: "user",
        metadata: { role: "user" },
      },
    ],
    budget: {
      maxInputTokens: 16000,
      reserveOutputTokens: 1024,
    },
    metadata: {},
    ...overrides,
  };
}

export function createTurnResult(
  overrides: Partial<RuntimeTurnResult> = {},
): RuntimeTurnResult {
  return {
    content: "I inspected the failure and found a config mismatch.",
    usage: {
      inputTokens: 500,
      outputTokens: 60,
      cacheReadTokens: 0,
    },
    metadata: {},
    ...overrides,
  };
}

export function createMockRuntime(
  overrides: Partial<RuntimeModuleRuntime> = {},
): RuntimeModuleRuntime {
  return {
    async callModel(ctx) {
      return {
        content: `mocked sidecar summary for ${ctx.sessionId}`,
        usage: {
          inputTokens: Math.ceil(ctx.prompt.length / 4),
          outputTokens: 48,
          cacheReadTokens: 0,
        },
        metadata: {},
      };
    },
    ...overrides,
  };
}
