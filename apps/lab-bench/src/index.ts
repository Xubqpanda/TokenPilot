import { RuntimePipeline } from "@ecoclaw/kernel";
import { createCacheModule } from "@ecoclaw/module-cache";
import { createSummaryModule } from "@ecoclaw/module-summary";
import { createCompressionModule } from "@ecoclaw/module-compression";
import { openaiAdapter } from "@ecoclaw/provider-openai";

async function main() {
  const pipeline = new RuntimePipeline({
    modules: [
      createCacheModule(),
      createSummaryModule({ idleTriggerMinutes: 50 }),
      createCompressionModule({ maxToolChars: 300 }),
    ],
    adapters: { openai: openaiAdapter },
  });

  const result = await pipeline.run(
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

  console.log("Pipeline sample done", result.usage);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

