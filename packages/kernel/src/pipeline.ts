import type { MetricsSink, ProviderAdapter, RuntimeModule } from "./interfaces.js";
import type { RuntimeTurnContext, RuntimeTurnResult } from "./types.js";

export type RuntimePipelineConfig = {
  modules: RuntimeModule[];
  adapters: Record<string, ProviderAdapter>;
  metrics?: MetricsSink;
};

export class RuntimePipeline {
  constructor(private readonly cfg: RuntimePipelineConfig) {}

  async run(ctx: RuntimeTurnContext, invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>) {
    let current = ctx;
    for (const mod of this.cfg.modules) {
      if (mod.beforeBuild) current = await mod.beforeBuild(current);
    }

    const adapter = this.cfg.adapters[current.provider];
    if (adapter) current = await adapter.annotatePrompt(current);

    for (const mod of this.cfg.modules) {
      if (mod.beforeCall) current = await mod.beforeCall(current);
    }

    let result = await invokeModel(current);

    for (const mod of [...this.cfg.modules].reverse()) {
      if (mod.afterCall) result = await mod.afterCall(current, result);
    }

    if (adapter && result.usage?.providerRaw) {
      result.usage = adapter.normalizeUsage(result.usage.providerRaw);
    }

    await this.cfg.metrics?.emit("turn.completed", {
      sessionId: current.sessionId,
      provider: current.provider,
      model: current.model,
      usage: result.usage ?? {},
    });

    return result;
  }
}
