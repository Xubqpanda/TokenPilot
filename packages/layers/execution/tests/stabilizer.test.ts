import test from "node:test";
import assert from "node:assert/strict";
import { findRuntimeEventsByType, ECOCLAW_EVENT_TYPES } from "@ecoclaw/kernel";
import { createStabilizerModule } from "../src/stabilizer/index.js";
import { createTurnContext, createTurnResult, createMockRuntime } from "./test-utils.js";

test("stabilizer records normalized signatures and cache observations", async () => {
  const module = createStabilizerModule({ minPrefixChars: 20 });
  const runtime = createMockRuntime();
  const ctx = createTurnContext({
    segments: [
      {
        id: "system-1",
        kind: "stable",
        text: "workspace=/tmp/run-123 user=abc created=2026-04-02T10:00:00Z 12345678901",
        priority: 10,
        source: "system",
      },
    ],
  });

  const built = await module.beforeBuild!(ctx, runtime);
  const stabilizerMeta = built.metadata?.stabilizer as Record<string, unknown>;
  assert.equal(stabilizerMeta.eligible, true);
  assert.ok(typeof stabilizerMeta.prefixSignature === "string");
  assert.ok(typeof stabilizerMeta.prefixSignatureNormalized === "string");
  assert.notEqual(stabilizerMeta.prefixSignature, stabilizerMeta.prefixSignatureNormalized);
  assert.equal(
    findRuntimeEventsByType(built.metadata, ECOCLAW_EVENT_TYPES.STABILIZER_BEFORE_BUILD_EVALUATED).length,
    1,
  );

  const result = createTurnResult({
    usage: { inputTokens: 120, outputTokens: 20, cacheReadTokens: 96, cacheWriteTokens: 12 },
  });
  const after = await module.afterCall!(built, result, runtime);
  const afterMeta = after.metadata?.stabilizer as Record<string, unknown>;
  assert.equal(afterMeta.observedCacheReadTokens, 96);
  assert.equal(afterMeta.observedInputTokens, 120);
  assert.equal(
    findRuntimeEventsByType(after.metadata, ECOCLAW_EVENT_TYPES.STABILIZER_AFTER_CALL_RECORDED).length,
    1,
  );
});
