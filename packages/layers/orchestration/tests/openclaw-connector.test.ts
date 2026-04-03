import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendResultEvent, ECOCLAW_EVENT_TYPES, type RuntimeModule, type RuntimeTurnContext } from "@ecoclaw/kernel";
import { createFileRuntimeStateStore } from "@ecoclaw/storage-fs";
import { createOpenClawConnector } from "../src/openclaw-connector.js";

function createTurnContext(sessionId: string): RuntimeTurnContext {
  return {
    sessionId,
    sessionMode: "single",
    provider: "openai",
    model: "gpt-test",
    prompt: "hello",
    segments: [
      {
        id: "stable-1",
        kind: "stable",
        text: "system prompt",
        priority: 1,
        source: "system",
      },
    ],
    budget: {
      maxInputTokens: 8000,
      reserveOutputTokens: 512,
    },
    metadata: {
      logicalSessionId: sessionId,
    },
  };
}

test("connector persists observed branches and messages for ordinary turns", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ecoclaw-orch-"));
  try {
    const store = createFileRuntimeStateStore({ stateDir });
    const connector = createOpenClawConnector({
      modules: [],
      adapters: {},
      stateStore: store,
      stateDir,
    });

    await connector.onLlmCall(createTurnContext("session-observed"), async () => ({
      content: "assistant reply",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
      },
    }));

    const branches = await store.listBranches("session-observed");
    const messages = await store.listMessages("session-observed");
    const turns = await store.listTurns("session-observed");

    assert.equal(branches.length, 1);
    assert.equal(branches[0]?.branchId, "session-observed");
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((message) => [message.role, message.content]),
      [
        ["user", "hello"],
        ["assistant", "assistant reply"],
      ],
    );
    assert.equal(turns.length, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("connector materializes an edited branch and persists synthetic messages", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ecoclaw-orch-"));
  try {
    const store = createFileRuntimeStateStore({ stateDir });
    const connector = createOpenClawConnector({
      modules: [],
      adapters: {},
      stateStore: store,
      stateDir,
      routing: {
        physicalSessionPrefix: "shadow",
      },
    });
    const sourceCtx = createTurnContext("session-draft");

    await connector.onLlmCall(sourceCtx, async () => ({
      content: "assistant reply",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
      },
    }));

    const materialized = await connector.materializeBranchEdit(
      {
        logicalSessionId: "session-draft",
        sourcePhysicalSessionId: "session-draft",
        sourceContext: sourceCtx,
        strategy: "draft_apply_materialized",
        sourceTraceId: "trace-1",
        messages: [
          {
            role: "assistant",
            kind: "summary",
            content: "condensed assistant summary",
          },
          {
            role: "user",
            kind: "message",
            content: "new user follow-up",
          },
        ],
        upstreamSeed: {
          prompt: "[seed] replay edited suffix",
          segments: [
            {
              id: "seed-1",
              kind: "stable",
              text: "EDITED_CONTEXT",
              priority: 2,
              source: "test",
            },
          ],
        },
      },
      async () => ({
        content: "seeded",
        usage: {
          inputTokens: 8,
          outputTokens: 2,
          cacheReadTokens: 0,
        },
      }),
    );

    const branches = await store.listBranches("session-draft");
    const allMessages = await store.listMessages("session-draft");
    const branchMessages = await store.listMessages("session-draft", {
      branchId: materialized.toPhysicalSessionId,
    });
    const seedTurns = await store.listTurns(materialized.toPhysicalSessionId);

    assert.equal(branches.length, 2);
    assert.equal(materialized.materializedMessageCount, 2);
    assert.equal(branchMessages.length, 2);
    assert.equal(branchMessages[0]?.parentMessageId, materialized.sourceMessageId);
    assert.equal(branchMessages[1]?.parentMessageId, branchMessages[0]?.messageId);
    assert.equal(allMessages.length, 4);
    assert.equal(seedTurns.length, 1);
    assert.equal(seedTurns[0]?.prompt, "[seed] replay edited suffix");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("compaction plan uses generic branch materialization flow", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ecoclaw-orch-"));
  try {
    const store = createFileRuntimeStateStore({ stateDir });
    const compactionModule: RuntimeModule = {
      name: "test-compaction",
      async afterCall(_ctx, result) {
        return appendResultEvent(result, {
          type: ECOCLAW_EVENT_TYPES.COMPACTION_PLAN_GENERATED,
          source: "test-compaction",
          at: new Date().toISOString(),
          payload: {
            planId: "plan-1",
            strategy: "summary_then_fork",
            summaryChars: 18,
            seedSummary: "compressed summary",
            compactionId: "compaction-1",
          },
        });
      },
    };
    const connector = createOpenClawConnector({
      modules: [compactionModule],
      adapters: {},
      stateStore: store,
      stateDir,
      routing: {
        physicalSessionPrefix: "shadow",
      },
    });

    const result = await connector.onLlmCall(createTurnContext("session-compaction"), async () => ({
      content: "assistant reply",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
      },
    }));

    const metadata = (result.metadata ?? {}) as Record<string, unknown>;
    const branchMaterialization = metadata.branchMaterialization as Record<string, unknown>;
    const compactionApply = metadata.compactionApply as Record<string, unknown>;
    const branches = await store.listBranches("session-compaction");
    const materializedBranchId = String(compactionApply.toPhysicalSessionId);
    const branchMessages = await store.listMessages("session-compaction", {
      branchId: materializedBranchId,
    });

    assert.equal(branches.length, 2);
    assert.equal(branchMaterialization.strategy, "summary_then_fork");
    assert.equal(compactionApply.materializedMessageCount, 1);
    assert.equal(branchMessages.length, 1);
    assert.equal(branchMessages[0]?.kind, "checkpoint_seed");
    assert.equal(branchMessages[0]?.content, "compressed summary");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
