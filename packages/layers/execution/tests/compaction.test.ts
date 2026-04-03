import test from "node:test";
import assert from "node:assert/strict";
import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  findRuntimeEventsByType,
} from "@ecoclaw/kernel";
import {
  buildCompactionPlan,
  createCompactionModule,
  generateCompactionArtifact,
} from "../src/compaction/index.js";
import { createMockRuntime, createTurnContext, createTurnResult } from "./test-utils.js";

test("compaction artifact produces a seed summary and plan without applying it", async () => {
  const blocks = [
    { id: "s1", role: "system" as const, text: "User prefers concise direct answers." },
    { id: "u1", role: "user" as const, text: "Refactor the execution layer modules." },
    { id: "a1", role: "assistant" as const, text: "Summary and compaction were split." },
  ];
  const artifact = await generateCompactionArtifact({
    blocks,
    requestedByPolicy: true,
    triggerSources: ["cache_miss_rate_threshold"],
    cfg: { generationMode: "heuristic" },
  });
  assert.equal(artifact.kind, "checkpoint_seed");
  assert.ok(artifact.seedSummary.includes(artifact.summaryText));

  const plan = buildCompactionPlan({
    strategy: "summary_then_fork",
    artifact,
    triggerReasons: ["cache_miss_rate_threshold"],
  });
  assert.ok(plan);
  assert.equal(plan?.strategy, "summary_then_fork");
  assert.ok(plan?.seedSummary.includes(artifact.resumePrefixPrompt));
});

test("compaction module emits compaction.plan.generated on policy request", async () => {
  const module = createCompactionModule({ generationMode: "heuristic" });
  const runtime = createMockRuntime();
  let ctx = createTurnContext();
  ctx = appendContextEvent(ctx, {
    type: ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED,
    source: "test-policy",
    at: new Date().toISOString(),
    payload: { reasons: ["turn_count_threshold"] },
  });

  const result = await module.afterCall!(ctx, createTurnResult(), runtime);
  const compactionMeta = result.metadata?.compaction as Record<string, unknown>;
  assert.ok(compactionMeta.plan);
  assert.ok(compactionMeta.artifact);
  assert.equal(
    findRuntimeEventsByType(result.metadata, ECOCLAW_EVENT_TYPES.COMPACTION_PLAN_GENERATED).length,
    1,
  );
});

test("compaction module follows policy generation-mode override", async () => {
  const module = createCompactionModule({ generationMode: "llm_full_context" });
  const runtime = createMockRuntime({
    async callModel() {
      throw new Error("compaction sidecar should not run");
    },
  });
  let ctx = createTurnContext({
    metadata: {
      policy: {
        decisions: {
          compaction: {
            generationMode: "heuristic",
          },
        },
      },
    },
  });
  ctx = appendContextEvent(ctx, {
    type: ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED,
    source: "test-policy",
    at: new Date().toISOString(),
    payload: { reasons: ["turn_count_threshold"] },
  });

  const result = await module.afterCall!(ctx, createTurnResult(), runtime);
  const compactionMeta = result.metadata?.compaction as Record<string, unknown>;
  const artifact = compactionMeta.artifact as Record<string, unknown>;
  const generation = artifact.generation as Record<string, unknown>;
  assert.equal(generation.mode, "heuristic");
});
