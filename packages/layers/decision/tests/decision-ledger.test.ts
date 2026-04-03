import test from "node:test";
import assert from "node:assert/strict";
import { ECOCLAW_EVENT_TYPES, appendResultEvent, findRuntimeEventsByType } from "@ecoclaw/kernel";
import { createDecisionLedgerModule } from "../src/decision-ledger.js";
import { createTurnContext, createTurnResult } from "./test-utils.js";

test("decision ledger records compaction generation usage alongside main turn roi", async () => {
  const module = createDecisionLedgerModule();
  const plannedCtx = await module.beforeCall!(createTurnContext(), {} as never);
  const result = appendResultEvent(
    {
      ...createTurnResult({
        usage: {
          inputTokens: 300,
          outputTokens: 40,
          cacheReadTokens: 120,
        },
        metadata: {
          compaction: {
            artifact: {
              generation: {
                mode: "llm_full_context_tail_prompt",
                provider: "openai",
                model: "gpt-test",
                requestedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                usage: {
                  inputTokens: 160,
                  outputTokens: 30,
                  cacheReadTokens: 0,
                },
                request: {},
              },
            },
          },
        },
      }),
    },
    {
      type: ECOCLAW_EVENT_TYPES.COMPACTION_PLAN_GENERATED,
      source: "test-compaction",
      at: new Date().toISOString(),
      payload: { planId: "plan-1" },
    },
  );

  const after = await module.afterCall!(plannedCtx, result, {} as never);
  const outcome = (after.metadata?.decisionLedger as Record<string, unknown>).outcome as Record<string, unknown>;
  const compactionGeneration = outcome.compactionGeneration as Record<string, unknown>;
  const roi = outcome.roi as Record<string, unknown>;

  assert.equal(compactionGeneration.requested, true);
  assert.equal(compactionGeneration.usageKnown, true);
  assert.equal(roi.compactionTurnNetTokenBenefit, -190);
  assert.equal(roi.effectiveTurnNetTokenBenefit, -410);
  assert.equal(
    findRuntimeEventsByType(after.metadata, ECOCLAW_EVENT_TYPES.DECISION_L1_RECORDED).length,
    1,
  );
});

test("decision ledger records handoff generation usage", async () => {
  const module = createDecisionLedgerModule();
  const plannedCtx = await module.beforeCall!(createTurnContext(), {} as never);
  const result = {
    ...createTurnResult({
      usage: {
        inputTokens: 200,
        outputTokens: 30,
        cacheReadTokens: 100,
      },
      metadata: {
        handoff: {
          artifact: {
            generation: {
              mode: "llm_full_context_tail_prompt",
              provider: "openai",
              model: "gpt-test",
              requestedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              usage: {
                inputTokens: 120,
                outputTokens: 20,
                cacheReadTokens: 0,
              },
              request: {},
            },
          },
        },
      },
    }),
  };

  const after = await module.afterCall!(plannedCtx, result, {} as never);
  const outcome = (after.metadata?.decisionLedger as Record<string, unknown>).outcome as Record<string, unknown>;
  const handoffGeneration = outcome.handoffGeneration as Record<string, unknown>;
  const roi = outcome.roi as Record<string, unknown>;

  assert.equal(handoffGeneration.requested, true);
  assert.equal(handoffGeneration.usageKnown, true);
  assert.equal(roi.handoffTurnNetTokenBenefit, -140);
  assert.equal(roi.effectiveTurnNetTokenBenefit, -270);
});
