import test from "node:test";
import assert from "node:assert/strict";
import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  findRuntimeEventsByType,
} from "@ecoclaw/kernel";
import {
  createHandoffModule,
  generateHandoffArtifact,
} from "../src/handoff/index.js";
import { createMockRuntime, createTurnContext, createTurnResult } from "./test-utils.js";

test("handoff artifact captures operational continuation info", async () => {
  const artifact = await generateHandoffArtifact({
    blocks: [
      { id: "u1", role: "user" as const, text: "Continue the benchmark investigation." },
      { id: "a1", role: "assistant" as const, text: "Baseline and plugin runs were collected." },
      { id: "t1", role: "tool" as const, text: "report.json saved under /tmp/report.json" },
    ],
    cfg: { generationMode: "heuristic" },
  });
  assert.equal(artifact.kind, "task_handoff");
  assert.ok(artifact.summaryText.includes("Next Actions"));
});

test("handoff module emits handoff.generated when requested", async () => {
  const module = createHandoffModule({ generationMode: "heuristic" });
  const runtime = createMockRuntime();
  let ctx = createTurnContext();
  ctx = appendContextEvent(ctx, {
    type: ECOCLAW_EVENT_TYPES.HANDOFF_REQUESTED,
    source: "test-handoff",
    at: new Date().toISOString(),
    payload: {},
  });

  const result = await module.afterCall!(ctx, createTurnResult(), runtime);
  assert.equal(
    findRuntimeEventsByType(result.metadata, ECOCLAW_EVENT_TYPES.HANDOFF_GENERATED).length,
    1,
  );
  const handoffMeta = result.metadata?.handoff as Record<string, unknown>;
  assert.ok(handoffMeta.artifact);
});

test("handoff module follows policy generation-mode override", async () => {
  const module = createHandoffModule({
    generationMode: "llm_full_context",
    triggerEventType: ECOCLAW_EVENT_TYPES.POLICY_HANDOFF_REQUESTED,
  });
  const runtime = createMockRuntime({
    async callModel() {
      throw new Error("handoff sidecar should not run");
    },
  });
  let ctx = createTurnContext({
    metadata: {
      policy: {
        decisions: {
          handoff: {
            generationMode: "heuristic",
          },
        },
      },
    },
  });
  ctx = appendContextEvent(ctx, {
    type: ECOCLAW_EVENT_TYPES.POLICY_HANDOFF_REQUESTED,
    source: "test-policy",
    at: new Date().toISOString(),
    payload: {},
  });

  const result = await module.afterCall!(ctx, createTurnResult(), runtime);
  const handoffMeta = result.metadata?.handoff as Record<string, unknown>;
  const artifact = handoffMeta.artifact as Record<string, unknown>;
  const generation = artifact.generation as Record<string, unknown>;
  assert.equal(generation.mode, "heuristic");
});
