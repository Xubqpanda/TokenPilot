import test from "node:test";
import assert from "node:assert/strict";
import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  findRuntimeEventsByType,
} from "@ecoclaw/kernel";
import {
  buildHeuristicSummaryText,
  createSummaryModule,
  generateSummaryArtifact,
} from "../src/summary/index.js";
import { createMockRuntime, createTurnContext, createTurnResult } from "./test-utils.js";

test("summary artifact only covers the provided block range", async () => {
  const blocks = [
    { id: "b1", role: "user" as const, text: "Investigate failing cache reuse." },
    { id: "b2", role: "assistant" as const, text: "I found the upstream parent chain is broken." },
    { id: "b3", role: "tool" as const, text: "rg output: previous_response_id not wired" },
  ];
  const heuristic = buildHeuristicSummaryText(blocks);
  assert.ok(heuristic.includes("Range summary for 3 selected blocks."));

  const artifact = await generateSummaryArtifact({
    request: { blocks, scopeLabel: "selected_range" },
    cfg: { generationMode: "heuristic" },
  });
  assert.equal(artifact.kind, "range_summary");
  assert.deepEqual(artifact.sourceBlockIds, ["b1", "b2", "b3"]);
  assert.equal(artifact.scopeLabel, "selected_range");
  assert.ok(artifact.summaryText.includes("selected blocks"));
});

test("summary module emits summary.generated when policy requests it", async () => {
  const module = createSummaryModule({ generationMode: "heuristic" });
  const runtime = createMockRuntime();
  let ctx = createTurnContext();
  ctx = appendContextEvent(ctx, {
    type: ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
    source: "test-policy",
    at: new Date().toISOString(),
    payload: { reasons: ["stable_chars_threshold"] },
  });

  const result = await module.afterCall!(ctx, createTurnResult(), runtime);
  const summaryMeta = result.metadata?.summary as Record<string, unknown>;
  assert.ok(summaryMeta.artifact);
  assert.equal(
    findRuntimeEventsByType(result.metadata, ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED).length,
    1,
  );
});

test("summary module follows policy generation-mode override", async () => {
  const module = createSummaryModule({ generationMode: "llm_full_context" });
  const runtime = createMockRuntime({
    async callModel() {
      throw new Error("summary sidecar should not run");
    },
  });
  let ctx = createTurnContext({
    metadata: {
      policy: {
        decisions: {
          summary: {
            generationMode: "heuristic",
          },
        },
      },
    },
  });
  ctx = appendContextEvent(ctx, {
    type: ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
    source: "test-policy",
    at: new Date().toISOString(),
    payload: { reasons: ["stable_chars_threshold"] },
  });

  const result = await module.afterCall!(ctx, createTurnResult(), runtime);
  const summaryMeta = result.metadata?.summary as Record<string, unknown>;
  const artifact = summaryMeta.artifact as Record<string, unknown>;
  const generation = artifact.generation as Record<string, unknown>;
  assert.equal(generation.mode, "heuristic");
});
