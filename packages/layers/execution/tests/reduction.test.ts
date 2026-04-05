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

test("html payloads keep only whitelisted attributes", async () => {
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-html",
        kind: "volatile",
        text: '<div class="hero" href="/" onclick="alert(1)" aria-label="Welcome" data-extra="secret"><p>hello</p></div>',
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "browser" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
  });

  const before = await module.beforeCall!(ctx, runtime);
  const text = before.segments[0]!.text;
  assert.ok(/onclick/.test(text) === false);
  assert.ok(/data-extra/.test(text) === false);
  assert.match(text, /aria-label="Welcome"/);
  assert.match(text, /href="\/"/);
  assert.match(text, /<p>hello<\/p>/);
});

test("reduction does not trim large markdown read payloads without explicit payload kind", async () => {
  const module = createReductionModule({
    maxToolChars: 320,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const readBody = [
    "# INCIDENT REPORT",
    "From: infra@example.com",
    "To: team@example.com",
    "Subject: Overnight outage summary",
    "",
    ...Array.from({ length: 36 }, (_, index) => `detail line ${index} with repeated operational context`),
    "",
    "## Next steps",
    "confirm rollback",
    "publish postmortem",
  ].join("\n");

  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-read-1",
        kind: "volatile",
        text: readBody,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "read" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
  });

  const before = await module.beforeCall!(ctx, runtime);
  const reduced = before.segments[0]!.text;
  assert.equal(reduced, readBody);
});

test("reduction does not trim plain-text reads with markdown code fences", async () => {
  const module = createReductionModule({
    maxToolChars: 320,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const readBody = [
    "# AGENTS.md",
    "",
    "## Memory",
    "",
    "```json",
    "{",
    '  "lastChecks": {',
    '    "email": 1703275200',
    "  }",
    "}",
    "```",
    "",
    ...Array.from({ length: 40 }, (_, index) => `plain line ${index} with long explanatory content`),
    "",
    "[13 more lines in file. Use offset=201 to continue.]",
  ].join("\n");

  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-read-codefence",
        kind: "volatile",
        text: readBody,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "read" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
  });

  const before = await module.beforeCall!(ctx, runtime);
  const reduced = before.segments[0]!.text;
  assert.equal(reduced, readBody);
});

test("reduction does not trim large plain-text email-like payloads without explicit payload kind", async () => {
  const module = createReductionModule({
    maxToolChars: 320,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const emailBody = [
    "From: alerts@example.com",
    "To: ops@example.com",
    "Subject: Build pipeline regression",
    "Date: Fri, 04 Apr 2026 09:15:00 +0800",
    "",
    ...Array.from({ length: 48 }, (_, index) => `body line ${index} with concrete diagnostic details`),
    "",
    "Regards,",
    "CI monitor",
  ].join("\n");

  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-email-1",
        kind: "volatile",
        text: emailBody,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "gmail_search" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
  });

  const before = await module.beforeCall!(ctx, runtime);
  assert.equal(before.segments[0]!.text, emailBody);
});
