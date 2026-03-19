import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ECOCLAW_EVENT_TYPES,
  findRuntimeEventsByType,
  RuntimePipeline,
  type RuntimeEvent,
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
  routing?: {
    autoForkOnPolicy?: boolean;
    physicalSessionPrefix?: string;
  };
  observability?: {
    eventTracePath?: string;
  };
};

export function createOpenClawConnector(cfg: OpenClawConnectorConfig) {
  const pipeline = new RuntimePipeline({ modules: cfg.modules, adapters: cfg.adapters });
  const stateStore =
    cfg.stateStore ??
    (cfg.stateDir ? createFileRuntimeStateStore({ stateDir: cfg.stateDir }) : undefined);
  const autoForkOnPolicy = cfg.routing?.autoForkOnPolicy ?? true;
  const physicalSessionPrefix = cfg.routing?.physicalSessionPrefix ?? "phy";
  const logicalToPhysical = new Map<string, string>();
  let forkCounter = 0;

  const toSerializable = <T>(value: T): T | undefined => {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return undefined;
    }
  };

  const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

  const toRecentMessagesText = (value: unknown): string => {
    if (!Array.isArray(value)) return "";
    return value
      .map((item, idx) => {
        const row = (item ?? {}) as Record<string, unknown>;
        const num = Number.isFinite(Number(row.index)) ? Number(row.index) : idx + 1;
        const at = String(row.at ?? "");
        const user = String(row.user ?? "");
        const assistant = String(row.assistant ?? "");
        return `[${num}] ${at}\nUSER: ${user}\nASSISTANT: ${assistant}`;
      })
      .join("\n\n");
  };

  const appendEventTrace = async (
    logicalSessionId: string,
    physicalSessionId: string,
    result: RuntimeTurnResult,
  ) => {
    const eventTracePath = cfg.observability?.eventTracePath;
    if (!eventTracePath) return;
    const trace = (result.metadata as Record<string, any> | undefined)?.ecoclawTrace;
    const finalMetadata = trace?.finalContext?.metadata as Record<string, unknown> | undefined;
    const finalCtxEvents = Array.isArray(finalMetadata?.ecoclawEvents)
      ? (finalMetadata?.ecoclawEvents as RuntimeEvent[])
      : [];
    const resultEvents = Array.isArray((result.metadata as Record<string, unknown> | undefined)?.ecoclawEvents)
      ? (((result.metadata as Record<string, unknown> | undefined)?.ecoclawEvents ?? []) as RuntimeEvent[])
      : [];
    const payload = {
      at: new Date().toISOString(),
      logicalSessionId,
      physicalSessionId,
      eventTypes: [...finalCtxEvents, ...resultEvents].map((e) => e.type),
      finalContextEvents: finalCtxEvents,
      resultEvents,
    };
    await mkdir(dirname(eventTracePath), { recursive: true });
    await appendFile(eventTracePath, `${JSON.stringify(payload)}\n`, "utf8");
  };

  const resolveRouting = (ctx: RuntimeTurnContext) => {
    const logicalSessionId =
      (ctx.metadata as Record<string, unknown> | undefined)?.logicalSessionId?.toString() ?? ctx.sessionId;
    const existingPhysical = logicalToPhysical.get(logicalSessionId);
    const physicalSessionId = existingPhysical ?? ctx.sessionId;
    logicalToPhysical.set(logicalSessionId, physicalSessionId);
    return { logicalSessionId, physicalSessionId };
  };

  const maybeForkAfterPolicy = async (
    logicalSessionId: string,
    physicalSessionId: string,
    ctx: RuntimeTurnContext,
    result: RuntimeTurnResult,
    invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>,
  ) => {
    if (!autoForkOnPolicy) return;
    const resultMeta = (result.metadata ?? {}) as Record<string, unknown>;
    const forkEvents = findRuntimeEventsByType(resultMeta, ECOCLAW_EVENT_TYPES.POLICY_FORK_RECOMMENDED);
    const summaryEvents = findRuntimeEventsByType(resultMeta, ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED);
    if (forkEvents.length === 0 || summaryEvents.length === 0) return;

    const latestSummary = summaryEvents[summaryEvents.length - 1];
    const summaryPayload = (latestSummary.payload ?? {}) as Record<string, unknown>;
    const summaryText = String(summaryPayload.summaryText ?? "").trim();
    if (!summaryText) return;
    const resumePrefixPrompt = String(summaryPayload.resumePrefixPrompt ?? "").trim();
    const recentMessagesText = toRecentMessagesText(summaryPayload.recentMessages);
    const seedSummary = [
      resumePrefixPrompt,
      summaryText,
      recentMessagesText ? `## Recent Raw Messages\n${recentMessagesText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    forkCounter += 1;
    const newPhysical = `${physicalSessionPrefix}-${safeName(logicalSessionId)}-f${forkCounter.toString().padStart(4, "0")}`;
    logicalToPhysical.set(logicalSessionId, newPhysical);
    await stateStore?.writeSummary(newPhysical, seedSummary, "policy-fork-seed");

    const seedCtx: RuntimeTurnContext = {
      ...ctx,
      sessionId: newPhysical,
      prompt: "[seed] Continue with compacted context summary.",
      metadata: {
        ...(ctx.metadata ?? {}),
        logicalSessionId,
        physicalSessionId: newPhysical,
        forkedFromSessionId: physicalSessionId,
        forkSeedSummaryChars: summaryText.length,
        policyBypass: true,
      },
      segments: [
        ...ctx.segments.filter((s) => s.kind === "stable"),
        {
          id: "fork-seed-summary",
          kind: "stable",
          text: `SEED_SUMMARY\n${seedSummary}`,
          priority: 2,
          source: "policy-fork",
        },
      ],
    };
    // Seed the new physical session for subsequent user turns.
    await pipeline.run(seedCtx, invokeModel);
  };

  return {
    // Placeholder: wire these to OpenClaw plugin hooks.
    async onBeforePromptBuild(ctx: any) {
      return ctx;
    },
    async onLlmCall(turnCtx: RuntimeTurnContext, invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>) {
      const startedAt = new Date().toISOString();
      const { logicalSessionId, physicalSessionId } = resolveRouting(turnCtx);
      const routedCtx: RuntimeTurnContext = {
        ...turnCtx,
        sessionId: physicalSessionId,
        metadata: {
          ...(turnCtx.metadata ?? {}),
          logicalSessionId,
          physicalSessionId,
        },
      };
      try {
        const result = await pipeline.run(routedCtx, invokeModel);
        await maybeForkAfterPolicy(logicalSessionId, physicalSessionId, routedCtx, result, invokeModel);
        const endedAt = new Date().toISOString();
        await appendEventTrace(logicalSessionId, physicalSessionId, result);
        await stateStore?.appendTurn({
          turnId: randomUUID(),
          sessionId: routedCtx.sessionId,
          provider: routedCtx.provider,
          model: routedCtx.model,
          prompt: routedCtx.prompt,
          segments: routedCtx.segments,
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
          sessionId: routedCtx.sessionId,
          provider: routedCtx.provider,
          model: routedCtx.model,
          prompt: routedCtx.prompt,
          segments: routedCtx.segments,
          responsePreview: "",
          trace: toSerializable<RuntimeTurnTrace>({
            initialContext: routedCtx,
            finalContext: routedCtx,
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
    getPhysicalSessionId(logicalSessionId: string) {
      return logicalToPhysical.get(logicalSessionId);
    },
  };
}
