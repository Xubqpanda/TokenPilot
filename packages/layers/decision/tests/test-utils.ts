import type { RuntimeTurnContext, RuntimeTurnResult } from "@ecoclaw/kernel";
import type { ContextViewSnapshot } from "@ecoclaw/layer-context";

export function createTurnContext(overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    sessionId: "decision-session-1",
    sessionMode: "single",
    provider: "openai",
    model: "gpt-test",
    apiFamily: "openai-responses",
    prompt: "continue the task",
    segments: [
      {
        id: "stable-1",
        kind: "stable",
        text: "S".repeat(2400),
        priority: 10,
        source: "system",
      },
      {
        id: "user-1",
        kind: "volatile",
        text: "Please continue.",
        priority: 5,
        source: "user",
        metadata: { role: "user" },
      },
    ],
    budget: {
      maxInputTokens: 16000,
      reserveOutputTokens: 1024,
    },
    metadata: {
      stabilizer: {
        eligible: true,
        prefixChars: 2400,
      },
    },
    ...overrides,
  };
}

export function createTurnResult(overrides: Partial<RuntimeTurnResult> = {}): RuntimeTurnResult {
  return {
    content: "acknowledged",
    usage: {
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 0,
    },
    metadata: {},
    ...overrides,
  };
}

export function createContextViewSnapshot(
  overrides: Partial<ContextViewSnapshot> = {},
): ContextViewSnapshot {
  const activeBranchId = overrides.activeBranchId ?? "branch-main";
  const activeReplayMessages =
    overrides.activeReplayMessages ??
    [
      {
        messageId: "m1",
        branchId: activeBranchId,
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "initial request",
        createdAt: "2026-04-02T10:00:00.000Z",
        chars: 15,
        approxTokens: 4,
      },
      {
        messageId: "m2",
        branchId: activeBranchId,
        parentMessageId: "m1",
        role: "assistant",
        kind: "message",
        origin: "provider_observed",
        content: "initial reply with enough detail to matter",
        createdAt: "2026-04-02T10:00:01.000Z",
        chars: 41,
        approxTokens: 10,
      },
    ];
  const branches =
    overrides.branches ??
    [
      {
        branchId: activeBranchId,
        createdAt: "2026-04-02T10:00:00.000Z",
        source: "test",
        directMessageCount: activeReplayMessages.length,
        replayMessageCount: activeReplayMessages.length,
        syntheticMessageCount: activeReplayMessages.filter((message) => message.origin !== "provider_observed")
          .length,
        observedMessageCount: activeReplayMessages.filter((message) => message.origin === "provider_observed")
          .length,
        lineageBranchIds: [activeBranchId],
      },
    ];
  return {
    sessionId: overrides.sessionId ?? "decision-session-1",
    activeBranchId,
    meta: overrides.meta ?? null,
    turnsCount: overrides.turnsCount ?? activeReplayMessages.length,
    branchCount: overrides.branchCount ?? branches.length,
    messageCount: overrides.messageCount ?? activeReplayMessages.length,
    activeReplayChars:
      overrides.activeReplayChars ?? activeReplayMessages.reduce((sum, message) => sum + message.chars, 0),
    activeReplayTokens:
      overrides.activeReplayTokens ?? activeReplayMessages.reduce((sum, message) => sum + message.approxTokens, 0),
    activeReplayMessages,
    branches,
    stats:
      overrides.stats ??
      {
        branchCount: branches.length,
        messageCount: activeReplayMessages.length,
        syntheticMessageCount: activeReplayMessages.filter((message) => message.origin !== "provider_observed")
          .length,
        observedMessageCount: activeReplayMessages.filter((message) => message.origin === "provider_observed")
          .length,
        toolMessageCount: activeReplayMessages.filter((message) => message.role === "tool").length,
        summaryMessageCount: activeReplayMessages.filter((message) => message.kind === "summary").length,
        checkpointSeedCount: activeReplayMessages.filter((message) => message.kind === "checkpoint_seed").length,
      },
    ...overrides,
  };
}
