import {
  createStabilizerModule,
  createCompactionModule,
  createSummaryModule,
  createReductionModule,
} from "@ecoclaw/layer-execution";
import { createTaskRouterModule, createPolicyModule, createDecisionLedgerModule } from "@ecoclaw/layer-decision";
import { createContextStateModule } from "@ecoclaw/layer-context";
import { createObservationSegment } from "@ecoclaw/kernel";
import { openaiAdapter } from "@ecoclaw/provider-openai";
import { createOpenClawConnector } from "@ecoclaw/layer-orchestration";
import { printTurnReport } from "./console-formatter.js";
import { resolveSummaryModuleConfig } from "./summary-config.js";

async function main() {
  const connector = createOpenClawConnector({
    modules: [
      createStabilizerModule({ minPrefixChars: 10 }),
      createPolicyModule(),
      createTaskRouterModule({
        enabled: true,
        tierRoutes: {
          simple: { provider: "openai", model: "gpt-5-mini" },
          complex: { provider: "openai", model: "gpt-5" },
          reasoning: { provider: "openai", model: "o3" },
        },
      }),
      createDecisionLedgerModule(),
      createContextStateModule({ maxSummaryChars: 600 }),
      createCompactionModule(),
      createSummaryModule(resolveSummaryModuleConfig()),
      createReductionModule({ maxToolChars: 300 }),
    ],
    adapters: { openai: openaiAdapter },
    stateDir: "/tmp/ecoclaw-lab-state",
    routing: {
      autoForkOnPolicy: true,
      physicalSessionPrefix: "phy",
    },
    observability: {
      eventTracePath: "/tmp/ecoclaw-lab-state/ecoclaw/event-trace.jsonl",
    },
  });

  const result = await connector.onLlmCall(
    {
      sessionId: "tui-logical-s1",
      sessionMode: "single",
      provider: "openai",
      model: "gpt-5",
      prompt: "Summarize",
      segments: [
        { id: "a", kind: "stable", text: "system prompt stable block", priority: 1 },
        { id: "b", kind: "volatile", text: "latest user turn", priority: 10 },
      ],
      budget: { maxInputTokens: 8000, reserveOutputTokens: 1000 },
      metadata: {
        logicalSessionId: "tui-logical-s1",
      },
    },
    async () => ({
      content: "x".repeat(500),
      usage: {
        providerRaw: {
          input_tokens: 200,
          output_tokens: 100,
          prompt_tokens_details: { cached_tokens: 128 },
        },
      },
    }),
  );

  const result2 = await connector.onLlmCall(
    {
      sessionId: "tui-logical-s1",
      sessionMode: "single",
      provider: "openai",
      model: "gpt-5",
      prompt: "Continue with concise next steps.",
      segments: [
        { id: "a2", kind: "stable", text: "system prompt stable block", priority: 1 },
        { id: "b2", kind: "volatile", text: "latest user turn", priority: 10 },
        createObservationSegment({
          id: "tool-json-1",
          text: JSON.stringify(
            {
              files: [
                { path: "src/app.ts", lines: 120, status: "modified" },
                { path: "src/cache.ts", lines: 420, status: "unchanged" },
              ],
              summary: "workspace diff snapshot",
              stdout: "scan complete",
            },
            null,
            2,
          ),
          source: "lab-bench",
          toolName: "workspace-scan",
          payloadKind: "json",
        }),
      ],
      budget: { maxInputTokens: 8000, reserveOutputTokens: 1000 },
      metadata: {
        logicalSessionId: "tui-logical-s1",
        turnObservations: [
          {
            id: "tool-stdout-1",
            text: [
              "stdout:",
              "scan start",
              "checked src/index.ts",
              "checked src/cache.ts",
              "checked src/router.ts",
              "checked src/ui.ts",
              "checked docs/architecture.md",
              "checked README.md",
              "scan complete",
            ].join("\n"),
            payloadKind: "stdout",
            toolName: "workspace-scan",
            source: "metadata.turnObservations",
          },
        ],
      },
    },
    async () => ({
      content: "y".repeat(300),
      usage: {
        providerRaw: {
          input_tokens: 180,
          output_tokens: 80,
          prompt_tokens_details: { cached_tokens: 96 },
        },
      },
    }),
  );

  await connector.writeSessionSummary("tui-logical-s1", "This is a sample persisted summary.", "bench");

  printTurnReport("Turn 1", result);
  printTurnReport("Turn 2", result2);
  console.log("Logical->Physical:", connector.getPhysicalSessionId("tui-logical-s1"));
  console.log("State root:", connector.getStateRootDir());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
