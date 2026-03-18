import { createCacheModule } from "@ecoclaw/module-cache";
import { createSummaryModule } from "@ecoclaw/module-summary";
import { createCompressionModule } from "@ecoclaw/module-compression";
import { createTaskRouterModule } from "@ecoclaw/module-task-router";
import { openaiAdapter } from "@ecoclaw/provider-openai";
import { createOpenClawConnector } from "@ecoclaw/connector-openclaw";

async function main() {
  const connector = createOpenClawConnector({
    modules: [
      createCacheModule(),
      createTaskRouterModule({
        enabled: true,
        tierRoutes: {
          simple: { provider: "openai", model: "gpt-5-mini" },
          complex: { provider: "openai", model: "gpt-5" },
          reasoning: { provider: "openai", model: "o3" },
        },
      }),
      createSummaryModule({ idleTriggerMinutes: 50 }),
      createCompressionModule({ maxToolChars: 300 }),
    ],
    adapters: { openai: openaiAdapter },
    stateDir: "D:/openclaw-context-runtime/.state",
  });

  const result = await connector.onLlmCall(
    {
      sessionId: "s1",
      sessionMode: "single",
      provider: "openai",
      model: "gpt-5",
      prompt: "Summarize",
      segments: [
        { id: "a", kind: "stable", text: "system prompt stable block", priority: 1 },
        { id: "b", kind: "volatile", text: "latest user turn", priority: 10 },
      ],
      budget: { maxInputTokens: 8000, reserveOutputTokens: 1000 },
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

  await connector.writeSessionSummary("s1", "This is a sample persisted summary.", "bench");

  console.log("Pipeline sample done", result.usage);
  console.log("State root:", connector.getStateRootDir());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
