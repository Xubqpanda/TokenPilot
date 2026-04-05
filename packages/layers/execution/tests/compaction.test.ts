import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("turn-local compaction archives consumed read payload after successful write", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "ecoclaw-turn-local-"));
  const module = createCompactionModule({
    turnLocalCompaction: {
      enabled: true,
      archiveDir,
    },
  });
  const runtime = createMockRuntime();
  const ctx = createTurnContext({
    sessionId: "session-turn-local",
    segments: [
      {
        id: "system-1",
        kind: "stable",
        text: "system",
        priority: 10,
        source: "system",
      },
      {
        id: "tool-read-1",
        kind: "volatile",
        text: "line-1\nline-2\nline-3",
        priority: 7,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "read",
            path: "/workspace/config/settings.json",
          },
        },
      },
      {
        id: "tool-read-2",
        kind: "volatile",
        text: "line-1\nline-2\nline-3", // Same content as first read
        priority: 6,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "read",
            path: "/workspace/config/settings.json",
          },
        },
      },
      {
        id: "tool-write-1",
        kind: "volatile",
        text: "Successfully wrote 45 bytes to /workspace/config/settings.json",
        priority: 5,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "write",
            path: "/workspace/config/settings.json",
          },
        },
      },
    ],
  });

  const nextCtx = await module.beforeCall!(ctx, runtime);

  // Both reads SHOULD be compacted (Scheme 4: all reads before a write are consumed)
  const firstReadText = nextCtx.segments[1]?.text ?? "";
  const secondReadText = nextCtx.segments[2]?.text ?? "";
  assert.match(firstReadText, /\[Archived read result/);
  assert.match(secondReadText, /\[Archived read result/);

  const compactionMeta = (nextCtx.metadata?.compaction as Record<string, unknown>)?.turnLocal as
    | Record<string, unknown>
    | undefined;
  assert.ok(compactionMeta);
  assert.equal(compactionMeta?.compactedCount, 2, "Should compact both reads");

  const archivePaths = (compactionMeta?.archivePaths as string[]) ?? [];
  assert.equal(archivePaths.length, 2);
});

test("turn-local compaction compacts all reads before a write (Scheme 4)", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "ecoclaw-turn-local-multiread-"));
  const module = createCompactionModule({
    turnLocalCompaction: {
      enabled: true,
      archiveDir,
    },
  });
  const runtime = createMockRuntime();
  const ctx = createTurnContext({
    sessionId: "session-multi-read",
    segments: [
      {
        id: "read-1",
        kind: "volatile",
        text: "SOUL.md content version 1",
        priority: 8,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "read",
            path: "SOUL.md",
          },
        },
      },
      {
        id: "read-2",
        kind: "volatile",
        text: "SOUL.md content version 1", // Same content
        priority: 7,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "read",
            path: "SOUL.md",
          },
        },
      },
      {
        id: "read-3",
        kind: "volatile",
        text: "SOUL.md content version 1", // Same content
        priority: 6,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "read",
            path: "SOUL.md",
          },
        },
      },
      {
        id: "write-1",
        kind: "volatile",
        text: "Successfully wrote 100 bytes to output.md",
        priority: 5,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "write",
            path: "output.md",
          },
        },
      },
    ],
  });

  const nextCtx = await module.beforeCall!(ctx, runtime);

  // All 3 reads SHOULD be compacted (Scheme 4: all reads before a write are consumed)
  const firstReadText = nextCtx.segments[0]?.text ?? "";
  const secondReadText = nextCtx.segments[1]?.text ?? "";
  const thirdReadText = nextCtx.segments[2]?.text ?? "";
  assert.match(firstReadText, /\[Archived read result for `SOUL\.md`\]/, "First read should be compacted");
  assert.match(secondReadText, /\[Archived read result for `SOUL\.md`\]/, "Second read should be compacted");
  assert.match(thirdReadText, /\[Archived read result for `SOUL\.md`\]/, "Third read should be compacted");

  const compactionMeta = (nextCtx.metadata?.compaction as Record<string, unknown>)?.turnLocal as
    | Record<string, unknown>
    | undefined;
  assert.ok(compactionMeta);
  assert.equal(compactionMeta?.compactedCount, 3, "Should compact all 3 reads");
});

test("turn-local compaction preserves reads that appear after the last write", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "ecoclaw-turn-local-reread-"));
  const module = createCompactionModule({
    turnLocalCompaction: {
      enabled: true,
      archiveDir,
    },
  });
  const runtime = createMockRuntime();
  const ctx = createTurnContext({
    sessionId: "session-reread",
    segments: [
      {
        id: "read-1",
        kind: "volatile",
        text: "config.json content (first read)",
        priority: 8,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "read",
            path: "config.json",
          },
        },
      },
      {
        id: "write-1",
        kind: "volatile",
        text: "Successfully wrote 50 bytes to output.md",
        priority: 5,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "write",
            path: "output.md",
          },
        },
      },
      {
        id: "read-2",
        kind: "volatile",
        text: "config.json content (re-read after write)",
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "read",
            path: "config.json",
          },
        },
      },
    ],
  });

  const nextCtx = await module.beforeCall!(ctx, runtime);

  // First read SHOULD be compacted (it's before the write, so it's consumed)
  const firstReadText = nextCtx.segments[0]?.text ?? "";
  assert.match(firstReadText, /\[Archived read result/, "First read should be compacted (consumed by write)");

  // Second read should NOT be compacted (it's after the write, nothing consumes it)
  const secondReadText = nextCtx.segments[2]?.text ?? "";
  assert.equal(secondReadText, "config.json content (re-read after write)", "Second read should not be compacted (appears after write)");

  const compactionMeta = (nextCtx.metadata?.compaction as Record<string, unknown>)?.turnLocal as
    | Record<string, unknown>
    | undefined;
  assert.ok(compactionMeta);
  assert.equal(compactionMeta?.compactedCount, 1, "Should compact 1 read (the one before the write)");
});
