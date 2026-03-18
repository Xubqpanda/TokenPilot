import { randomUUID } from "node:crypto";
import {
  RuntimePipeline,
  type RuntimeModule,
  type RuntimeStateStore,
  type RuntimeTurnContext,
  type RuntimeTurnTrace,
  type RuntimeTurnResult,
} from "@ecoclaw/kernel";
import { createFileRuntimeStateStore } from "@ecoclaw/storage-fs";

export type OpenClawConnectorConfig = {
  modules: RuntimeModule[];
  adapters: Record<string, any>;
  stateDir?: string;
  stateStore?: RuntimeStateStore;
};

export function createOpenClawConnector(cfg: OpenClawConnectorConfig) {
  const pipeline = new RuntimePipeline({ modules: cfg.modules, adapters: cfg.adapters });
  const stateStore =
    cfg.stateStore ??
    (cfg.stateDir ? createFileRuntimeStateStore({ stateDir: cfg.stateDir }) : undefined);

  const toSerializable = <T>(value: T): T | undefined => {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return undefined;
    }
  };

  return {
    // Placeholder: wire these to OpenClaw plugin hooks.
    async onBeforePromptBuild(ctx: any) {
      return ctx;
    },
    async onLlmCall(turnCtx: RuntimeTurnContext, invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>) {
      const startedAt = new Date().toISOString();
      try {
        const result = await pipeline.run(turnCtx, invokeModel);
        const endedAt = new Date().toISOString();
        await stateStore?.appendTurn({
          turnId: randomUUID(),
          sessionId: turnCtx.sessionId,
          provider: turnCtx.provider,
          model: turnCtx.model,
          prompt: turnCtx.prompt,
          segments: turnCtx.segments,
          usage: result.usage,
          responsePreview: result.content.slice(0, 800),
          response: result.content,
          trace: toSerializable<RuntimeTurnTrace | undefined>(
            (result.metadata as Record<string, unknown> | undefined)?.ecoclawTrace as
              | RuntimeTurnTrace
              | undefined,
          ),
          resultMetadata: toSerializable(result.metadata),
          startedAt,
          endedAt,
          status: "ok",
        });
        return result;
      } catch (err) {
        const endedAt = new Date().toISOString();
        await stateStore?.appendTurn({
          turnId: randomUUID(),
          sessionId: turnCtx.sessionId,
          provider: turnCtx.provider,
          model: turnCtx.model,
          prompt: turnCtx.prompt,
          segments: turnCtx.segments,
          responsePreview: "",
          trace: toSerializable<RuntimeTurnTrace>({
            initialContext: turnCtx,
            finalContext: turnCtx,
            moduleSteps: [],
            responsePreview: "",
          }),
          startedAt,
          endedAt,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    async writeSessionSummary(sessionId: string, summary: string, source = "manual") {
      await stateStore?.writeSummary(sessionId, summary, source);
    },
    getStateRootDir() {
      return cfg.stateDir ? `${cfg.stateDir}/ecoclaw` : undefined;
    },
  };
}
