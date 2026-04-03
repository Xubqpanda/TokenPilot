import test from "node:test";
import assert from "node:assert/strict";
import { ECOCLAW_EVENT_TYPES, findRuntimeEventsByType } from "@ecoclaw/kernel";
import { createPolicyModule, readPolicyOnlineMetadata } from "../src/policy.js";
import { createContextViewSnapshot, createTurnContext } from "./test-utils.js";

test("policy requests summary and compaction from subtask-boundary locality signals", async () => {
  const module = createPolicyModule({
    summaryGenerationMode: "heuristic",
    compactionEnabled: true,
    cacheHealthEnabled: false,
  });
  const sessionId = "decision-subtask-boundary";
  const contextView = createContextViewSnapshot({
    sessionId,
    activeReplayMessages: [
      {
        messageId: "m1",
        branchId: "branch-main",
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "Implement the cache stabilizer and keep the forwarded payload prefix stable across branches.",
        createdAt: "2026-04-02T10:00:00.000Z",
        chars: 88,
        approxTokens: 22,
      },
      {
        messageId: "m2",
        branchId: "branch-main",
        parentMessageId: "m1",
        role: "assistant",
        kind: "message",
        origin: "provider_observed",
        content: "The stabilizer work is done. The prefix is normalized and the cache-focused tests are passing.",
        createdAt: "2026-04-02T10:00:01.000Z",
        chars: 95,
        approxTokens: 24,
      },
      {
        messageId: "m3",
        branchId: "branch-main",
        parentMessageId: "m2",
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "Now switch to the policy layer and redesign it around locality signals instead of token thresholds.",
        createdAt: "2026-04-02T10:00:02.000Z",
        chars: 101,
        approxTokens: 26,
      },
      {
        messageId: "m4",
        branchId: "branch-main",
        parentMessageId: "m3",
        role: "assistant",
        kind: "message",
        origin: "provider_observed",
        content: "I am restructuring the decision logic around locality-aware triggers now.",
        createdAt: "2026-04-02T10:00:03.000Z",
        chars: 74,
        approxTokens: 19,
      },
    ],
  });

  const nextCtx = await module.beforeBuild!(
    createTurnContext({
      sessionId,
      metadata: {
        stabilizer: {
          eligible: true,
          prefixChars: 2400,
        },
        contextView,
      },
    }),
    {} as never,
  );
  const policy = readPolicyOnlineMetadata(nextCtx.metadata)!;

  assert.equal(policy.decisions.summary.requested, true);
  assert.equal(policy.decisions.compaction.requested, true);
  assert.ok(policy.decisions.summary.reasons.includes("locality_subtask_boundary"));
  assert.ok(policy.decisions.compaction.reasons.includes("locality_subtask_boundary"));
  assert.deepEqual(policy.decisions.locality.summaryCandidateMessageIds, ["m1", "m2"]);
  assert.deepEqual(policy.decisions.locality.compactionCandidateBranchIds, ["branch-main"]);
  assert.equal(
    findRuntimeEventsByType(nextCtx.metadata, ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED).length,
    1,
  );
  assert.equal(
    findRuntimeEventsByType(nextCtx.metadata, ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED).length,
    1,
  );
});

test("policy arbitrates shared llm budget between summary and compaction when both are signal-driven", async () => {
  const module = createPolicyModule({
    summaryGenerationMode: "llm_full_context",
    summaryMaxOutputTokens: 256,
    compactionEnabled: true,
    cacheHealthEnabled: false,
  });
  const sessionId = "decision-signal-arbitration";
  const contextView = createContextViewSnapshot({
    sessionId,
    activeReplayMessages: [
      {
        messageId: "m1",
        branchId: "branch-main",
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "Finish the cache-prefix normalization work and preserve dynamic fields outside the stable prefix.",
        createdAt: "2026-04-02T10:00:00.000Z",
        chars: 260,
        approxTokens: 65,
      },
      {
        messageId: "m2",
        branchId: "branch-main",
        parentMessageId: "m1",
        role: "assistant",
        kind: "message",
        origin: "provider_observed",
        content: "That part is completed and the branch reuse behavior is stable in the latest run.",
        createdAt: "2026-04-02T10:00:01.000Z",
        chars: 240,
        approxTokens: 60,
      },
      {
        messageId: "m3",
        branchId: "branch-main",
        parentMessageId: "m2",
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "Next, rebuild the decision layer so locality signals drive summary, reduction, handoff, and compaction.",
        createdAt: "2026-04-02T10:00:02.000Z",
        chars: 107,
        approxTokens: 27,
      },
      {
        messageId: "m4",
        branchId: "branch-main",
        parentMessageId: "m3",
        role: "assistant",
        kind: "message",
        origin: "provider_observed",
        content: "I am rebuilding the decision layer around locality-driven policy routing now.",
        createdAt: "2026-04-02T10:00:03.000Z",
        chars: 76,
        approxTokens: 19,
      },
    ],
  });

  const nextCtx = await module.beforeBuild!(
    createTurnContext({
      sessionId,
      metadata: {
        stabilizer: {
          eligible: true,
          prefixChars: 2400,
        },
        contextView,
      },
    }),
    {} as never,
  );
  const policy = readPolicyOnlineMetadata(nextCtx.metadata)!;

  assert.equal(policy.decisions.summary.requested, true);
  assert.equal(policy.decisions.compaction.requested, true);
  assert.equal(policy.decisions.compaction.generationMode, "llm_full_context");
  assert.equal(policy.decisions.summary.generationMode, "heuristic");
  assert.equal(policy.decisions.compaction.arbitration, "llm_budget_owner");
  assert.equal(policy.decisions.summary.arbitration, "llm_budget_downgrade");
  assert.deepEqual(policy.decisions.semantic.plannedLlmCalls, ["compaction"]);
  assert.deepEqual(policy.decisions.semantic.heuristicFallbacks, ["summary"]);
  assert.equal(policy.decisions.semantic.llmBudgetOwner, "compaction");
});

test("policy requests handoff from hard-loop locality signals", async () => {
  const module = createPolicyModule({
    handoffEnabled: true,
    handoffGenerationMode: "heuristic",
    compactionEnabled: false,
    cacheHealthEnabled: false,
    localityHardLoopWindowMessages: 6,
    localityHardLoopMinRepeats: 2,
  });
  const sessionId = "decision-hard-loop-handoff";
  const contextView = createContextViewSnapshot({
    sessionId,
    activeReplayMessages: [
      {
        messageId: "m1",
        branchId: "branch-main",
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "Open the workspace file and keep going.",
        createdAt: "2026-04-02T10:00:00.000Z",
        chars: 37,
        approxTokens: 9,
      },
      {
        messageId: "m2",
        branchId: "branch-main",
        parentMessageId: "m1",
        role: "assistant",
        kind: "message",
        origin: "provider_observed",
        content: "Trying the file lookup again.",
        createdAt: "2026-04-02T10:00:01.000Z",
        chars: 28,
        approxTokens: 7,
      },
      {
        messageId: "m3",
        branchId: "branch-main",
        parentMessageId: "m2",
        role: "tool",
        kind: "context_snapshot",
        origin: "synthetic_materialized",
        content: "stderr: ENOENT: no such file or directory, open '/tmp/project/SOUL.md'",
        createdAt: "2026-04-02T10:00:02.000Z",
        chars: 70,
        approxTokens: 18,
        metadata: { payloadKind: "stderr", toolName: "read" },
      },
      {
        messageId: "m4",
        branchId: "branch-main",
        parentMessageId: "m3",
        role: "tool",
        kind: "context_snapshot",
        origin: "synthetic_materialized",
        content: "stderr: ENOENT: no such file or directory, open '/tmp/project/SOUL.md'",
        createdAt: "2026-04-02T10:00:03.000Z",
        chars: 70,
        approxTokens: 18,
        metadata: { payloadKind: "stderr", toolName: "read" },
      },
      {
        messageId: "m5",
        branchId: "branch-main",
        parentMessageId: "m4",
        role: "tool",
        kind: "context_snapshot",
        origin: "synthetic_materialized",
        content: "stderr: ENOENT: no such file or directory, open '/tmp/project/SOUL.md'",
        createdAt: "2026-04-02T10:00:04.000Z",
        chars: 70,
        approxTokens: 18,
        metadata: { payloadKind: "stderr", toolName: "read" },
      },
    ],
  });

  const nextCtx = await module.beforeBuild!(
    createTurnContext({
      sessionId,
      metadata: {
        stabilizer: {
          eligible: true,
          prefixChars: 2400,
        },
        contextView,
      },
    }),
    {} as never,
  );
  const policy = readPolicyOnlineMetadata(nextCtx.metadata)!;

  assert.equal(policy.decisions.handoff.requested, true);
  assert.ok(policy.decisions.handoff.reasons.includes("locality_hard_loop_detected"));
  assert.deepEqual(policy.decisions.locality.handoffCandidateMessageIds, ["m3", "m4", "m5"]);
  assert.equal(
    findRuntimeEventsByType(nextCtx.metadata, ECOCLAW_EVENT_TYPES.POLICY_HANDOFF_REQUESTED).length,
    1,
  );
});

test("policy uses content-type, structural, and error signals to drive reduction", async () => {
  const module = createPolicyModule({
    compactionEnabled: false,
    cacheHealthEnabled: false,
    localityStructuralPayloadMinChars: 40,
    localityErrorMinChars: 20,
  });
  const sessionId = "decision-structural-reduction";
  const contextView = createContextViewSnapshot({
    sessionId,
    activeReplayMessages: [
      {
        messageId: "m1",
        branchId: "branch-main",
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "Inspect the rendered HTML payload and reduce it before replay.",
        createdAt: "2026-04-02T10:00:00.000Z",
        chars: 58,
        approxTokens: 15,
      },
      {
        messageId: "m2",
        branchId: "branch-main",
        parentMessageId: "m1",
        role: "assistant",
        kind: "message",
        origin: "provider_observed",
        content: "I found a large HTML blob and an error response in the observation stream.",
        createdAt: "2026-04-02T10:00:01.000Z",
        chars: 72,
        approxTokens: 18,
      },
      {
        messageId: "m3",
        branchId: "branch-main",
        parentMessageId: "m2",
        role: "tool",
        kind: "context_snapshot",
        origin: "synthetic_materialized",
        content:
          "<html><body><div class='card' id='root'><script>alert(1)</script><a href='/docs'>Docs</a><span>Error: 404 not found</span></div></body></html>",
        createdAt: "2026-04-02T10:00:02.000Z",
        chars: 148,
        approxTokens: 37,
        metadata: { payloadKind: "html", toolName: "browser.snapshot" },
      },
    ],
  });

  const nextCtx = await module.beforeBuild!(
    createTurnContext({
      sessionId,
      metadata: {
        stabilizer: {
          eligible: true,
          prefixChars: 2400,
        },
        contextView,
      },
    }),
    {} as never,
  );
  const policy = readPolicyOnlineMetadata(nextCtx.metadata)!;

  assert.ok(policy.decisions.reduction.reasons.includes("locality_content_type_prior"));
  assert.ok(policy.decisions.reduction.reasons.includes("locality_structural_payload_detected"));
  assert.ok(policy.decisions.reduction.reasons.includes("locality_error_prune"));
  assert.equal(policy.decisions.reduction.beforeCallPassIds.includes("tool_payload_trim"), true);
  assert.equal(policy.decisions.locality.reductionCandidateMessageIds.includes("m3"), true);
  assert.equal(policy.signals.locality.reductionCandidateChars >= 148, true);
});

test("content-type and structural signal scores are independent from chars", async () => {
  const module = createPolicyModule({
    compactionEnabled: false,
    cacheHealthEnabled: false,
    localityStructuralPayloadMinChars: 1,
  });
  const sessionId = "decision-score-decoupled";
  const contextView = createContextViewSnapshot({
    sessionId,
    activeReplayMessages: [
      {
        messageId: "m1",
        branchId: "branch-main",
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "Inspect the html payload.",
        createdAt: "2026-04-02T10:00:00.000Z",
        chars: 25,
        approxTokens: 6,
      },
      {
        messageId: "m2",
        branchId: "branch-main",
        parentMessageId: "m1",
        role: "tool",
        kind: "context_snapshot",
        origin: "synthetic_materialized",
        content: "<html><body><a href='/a'>A</a></body></html>",
        createdAt: "2026-04-02T10:00:01.000Z",
        chars: 44,
        approxTokens: 11,
        metadata: { payloadKind: "html", toolName: "browser.snapshot" },
      },
      {
        messageId: "m3",
        branchId: "branch-main",
        parentMessageId: "m2",
        role: "tool",
        kind: "context_snapshot",
        origin: "synthetic_materialized",
        content:
          "<html><body><div class='layout'>" +
          "x".repeat(1200) +
          "<a href='/b'>B</a></div></body></html>",
        createdAt: "2026-04-02T10:00:02.000Z",
        chars: 1260,
        approxTokens: 315,
        metadata: { payloadKind: "html", toolName: "browser.snapshot" },
      },
    ],
  });

  const nextCtx = await module.beforeBuild!(
    createTurnContext({
      sessionId,
      metadata: {
        stabilizer: {
          eligible: true,
          prefixChars: 2400,
        },
        contextView,
      },
    }),
    {} as never,
  );
  const policy = readPolicyOnlineMetadata(nextCtx.metadata)!;
  const signals = policy.decisions.locality.signals;

  const contentReduceM2 = signals.find((signal) => signal.id === "content-reduce:m2");
  const contentReduceM3 = signals.find((signal) => signal.id === "content-reduce:m3");
  const structuralM2 = signals.find((signal) => signal.id === "structural:m2");
  const structuralM3 = signals.find((signal) => signal.id === "structural:m3");

  assert.ok(contentReduceM2);
  assert.ok(contentReduceM3);
  assert.ok(structuralM2);
  assert.ok(structuralM3);
  assert.equal(contentReduceM2?.score, contentReduceM3?.score);
  assert.equal(structuralM2?.score, structuralM3?.score);
  assert.notEqual(
    contentReduceM2?.cost?.chars,
    contentReduceM3?.cost?.chars,
  );
  assert.notEqual(
    structuralM2?.cost?.chars,
    structuralM3?.cost?.chars,
  );
});
