import test from "node:test";
import assert from "node:assert/strict";
import { ECOCLAW_EVENT_TYPES, findRuntimeEventsByType } from "@ecoclaw/kernel";
import { createReductionModule } from "../src/reduction/index.js";
import { createMockRuntime, createTurnContext, createTurnResult } from "./test-utils.js";

test("reduction trims tool payloads before call and slims formatting after call", async () => {
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const toolBody = Array.from({ length: 40 }, (_, index) => `line-${index} some verbose output`).join("\n");
  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-1",
        kind: "volatile",
        text: `stdout:\n${toolBody}`,
        priority: 4,
        source: "tool",
        metadata: { role: "tool" },
      },
    ],
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: ["tool_payload_trim"],
            afterCallPassIds: ["format_slimming"],
          },
        },
      },
    },
  });

  const before = await module.beforeCall!(ctx, runtime);
  assert.ok(before.segments[0]!.text.includes("reduced lines="));
  assert.equal(
    findRuntimeEventsByType(before.metadata, ECOCLAW_EVENT_TYPES.REDUCTION_BEFORE_CALL_RECORDED).length,
    1,
  );

  const result = createTurnResult({
    content: "```ts\nconst x = 1;\n```\n\n\nnext line  ",
  });
  const after = await module.afterCall!(before, result, runtime);
  assert.equal(after.content.includes("```"), false);
  assert.equal(after.content.includes("\n\n\n"), false);
  const reductionMeta = after.metadata?.reduction as Record<string, unknown>;
  assert.ok(reductionMeta.afterCallSummary);
  assert.equal(
    findRuntimeEventsByType(after.metadata, ECOCLAW_EVENT_TYPES.REDUCTION_AFTER_CALL_RECORDED).length,
    1,
  );
});
