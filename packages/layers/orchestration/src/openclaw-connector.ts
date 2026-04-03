import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ECOCLAW_EVENT_TYPES,
  appendRuntimeEvent,
  createObservationSegment,
  findRuntimeEventsByType,
  RuntimePipeline,
  resolveApiFamily,
  type ContextSegment,
  type ObservationPayloadKind,
  type ObservationRole,
  type PersistedMessageKind,
  type PersistedMessageOrigin,
  type PersistedMessageRecord,
  type PersistedMessageRole,
  type RuntimeEvent,
  type RuntimeModule,
  type RuntimeStateStore,
  type RuntimeTurnContext,
  type RuntimeTurnTrace,
  type RuntimeTurnResult,
} from "@ecoclaw/kernel";
import { buildContextSessionView, buildContextViewSnapshot } from "@ecoclaw/layer-context";
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

export type MaterializedBranchMessageInput = {
  role: PersistedMessageRole;
  content: string;
  kind?: PersistedMessageKind;
  origin?: PersistedMessageOrigin;
  source?: string;
  replacesMessageIds?: string[];
  derivedFromArtifactId?: string;
  metadata?: Record<string, unknown>;
};

export type BranchUpstreamSeed = {
  prompt: string;
  segments: ContextSegment[];
  metadata?: Record<string, unknown>;
};

export type BranchMaterializationRequest = {
  logicalSessionId: string;
  sourcePhysicalSessionId: string;
  sourceContext: RuntimeTurnContext;
  strategy: string;
  sourceTraceId?: string;
  sourceMessageId?: string;
  planId?: string;
  messages: MaterializedBranchMessageInput[];
  upstreamSeed?: BranchUpstreamSeed;
};

export type BranchMaterializationResult = {
  applied: boolean;
  logicalSessionId: string;
  fromPhysicalSessionId: string;
  toPhysicalSessionId: string;
  branchId: string;
  strategy: string;
  sourceTraceId?: string;
  sourceMessageId?: string;
  planId?: string;
  messageIds: string[];
  materializedMessageCount: number;
  headMessageId?: string;
  seedUsage?: RuntimeTurnResult["usage"];
};

export function createOpenClawConnector(cfg: OpenClawConnectorConfig) {
  const pipeline = new RuntimePipeline({ modules: cfg.modules, adapters: cfg.adapters });
  const stateStore =
    cfg.stateStore ??
    (cfg.stateDir ? createFileRuntimeStateStore({ stateDir: cfg.stateDir }) : undefined);
  const autoForkOnPolicy = cfg.routing?.autoForkOnPolicy ?? true;
  const physicalSessionPrefix = cfg.routing?.physicalSessionPrefix ?? "phy";
  const logicalToPhysical = new Map<string, string>();
  const knownPhysicalBranches = new Set<string>();
  const branchHeadMessageIdByPhysical = new Map<string, string>();
  let forkCounter = 0;
  const manualBranchRoutingPath = cfg.stateDir
    ? join(cfg.stateDir, "ecoclaw", "controls", "manual-branch-routing.json")
    : undefined;

  const toSerializable = <T>(value: T): T | undefined => {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return undefined;
    }
  };

  const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

  const readManualBranchBindings = async (): Promise<Map<string, string>> => {
    if (!manualBranchRoutingPath) return new Map();
    try {
      const raw = await readFile(manualBranchRoutingPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const bindings =
        parsed.bindings && typeof parsed.bindings === "object"
          ? (parsed.bindings as Record<string, unknown>)
          : {};
      const out = new Map<string, string>();
      for (const [logicalSessionId, value] of Object.entries(bindings)) {
        if (!value || typeof value !== "object") continue;
        const physicalSessionId = String((value as Record<string, unknown>).physicalSessionId ?? "").trim();
        if (!physicalSessionId) continue;
        out.set(logicalSessionId, physicalSessionId);
      }
      return out;
    } catch {
      return new Map();
    }
  };

  const normalizePayloadKind = (value: unknown): ObservationPayloadKind | undefined => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "stdout" ||
      normalized === "stderr" ||
      normalized === "json" ||
      normalized === "blob"
    ) {
      return normalized;
    }
    return undefined;
  };

  const normalizeObservationRole = (value: unknown): ObservationRole | undefined => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "tool" || normalized === "observation") return normalized;
    return undefined;
  };

  const normalizeObservationStability = (
    value: unknown,
  ): ContextSegment["kind"] | undefined => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "stable" ||
      normalized === "semi_stable" ||
      normalized === "volatile"
    ) {
      return normalized;
    }
    return undefined;
  };

  const buildObservationSegments = (ctx: RuntimeTurnContext): ContextSegment[] => {
    const metadata =
      ctx.metadata && typeof ctx.metadata === "object"
        ? (ctx.metadata as Record<string, unknown>)
        : undefined;
    if (!metadata) return [];

    const out: ContextSegment[] = [];
    const turnObservations = Array.isArray(metadata.turnObservations)
      ? metadata.turnObservations
      : [];
    for (let i = 0; i < turnObservations.length; i += 1) {
      const item = turnObservations[i];
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) continue;
        out.push(
          createObservationSegment({
            id: `turn-observation-${i + 1}`,
            text,
            source: "metadata.turnObservations",
            role: "observation",
          }),
        );
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      if (!text) continue;
      out.push(
        createObservationSegment({
          id:
            typeof obj.id === "string" && obj.id.trim().length > 0
              ? obj.id.trim()
              : `turn-observation-${i + 1}`,
          text,
          priority:
            typeof obj.priority === "number" && Number.isFinite(obj.priority)
              ? obj.priority
              : undefined,
          stability: normalizeObservationStability(obj.stability),
          source:
            typeof obj.source === "string" && obj.source.trim().length > 0
              ? obj.source.trim()
              : "metadata.turnObservations",
          role: normalizeObservationRole(obj.role),
          payloadKind: normalizePayloadKind(obj.payloadKind),
          toolName:
            typeof obj.toolName === "string" && obj.toolName.trim().length > 0
              ? obj.toolName.trim()
              : undefined,
          origin:
            typeof obj.origin === "string" && obj.origin.trim().length > 0
              ? obj.origin.trim()
              : undefined,
          mimeType:
            typeof obj.mimeType === "string" && obj.mimeType.trim().length > 0
              ? obj.mimeType.trim()
              : undefined,
          truncated:
            typeof obj.truncated === "boolean" ? obj.truncated : undefined,
          metadata:
            obj.metadata && typeof obj.metadata === "object"
              ? (obj.metadata as Record<string, unknown>)
              : undefined,
        }),
      );
    }

    const turnTools = Array.isArray(metadata.turnTools) ? metadata.turnTools : [];
    for (let i = 0; i < turnTools.length; i += 1) {
      const item = turnTools[i];
      if (typeof item !== "string") continue;
      const text = item.trim();
      if (!text) continue;
      out.push(
        createObservationSegment({
          id: `turn-tool-${i + 1}`,
          text,
          source: "metadata.turnTools",
          role: "tool",
        }),
      );
    }

    return out;
  };

  const appendEventTrace = async (
    logicalSessionId: string,
    physicalSessionId: string,
    turnCtx: RuntimeTurnContext,
    result: RuntimeTurnResult,
  ) => {
    const eventTracePath = cfg.observability?.eventTracePath;
    if (!eventTracePath) return;
    const resultMetadata = (result.metadata as Record<string, unknown> | undefined) ?? {};
    const trace = (resultMetadata as Record<string, any> | undefined)?.ecoclawTrace;
    const finalMetadata = trace?.finalContext?.metadata as Record<string, unknown> | undefined;
    const finalCtxEvents = Array.isArray(finalMetadata?.ecoclawEvents)
      ? (finalMetadata?.ecoclawEvents as RuntimeEvent[])
      : [];
    const resultEvents = Array.isArray(resultMetadata?.ecoclawEvents)
      ? ((resultMetadata.ecoclawEvents ?? []) as RuntimeEvent[])
      : [];
    const branchMaterialization = asRecord(resultMetadata.branchMaterialization);
    const compactionApply = asRecord(resultMetadata.compactionApply);
    const branchMeta = branchMaterialization ?? compactionApply;
    const payload = {
      at: new Date().toISOString(),
      logicalSessionId,
      physicalSessionId,
      branch: {
        logicalSessionId,
        physicalSessionId,
        forkedFromSessionId:
          (turnCtx.metadata as Record<string, unknown> | undefined)?.forkedFromSessionId ??
          finalMetadata?.forkedFromSessionId ??
          undefined,
        branchStrategy:
          branchMeta?.strategy ??
          finalMetadata?.branchStrategy ??
          undefined,
        planId:
          branchMeta?.planId ??
          finalMetadata?.planId ??
          undefined,
        spawnedPhysicalSessionId: branchMeta?.toPhysicalSessionId ?? undefined,
        spawnedFromPhysicalSessionId: branchMeta?.fromPhysicalSessionId ?? undefined,
      },
      provider: turnCtx.provider,
      model: turnCtx.model,
      apiFamily: turnCtx.apiFamily ?? resolveApiFamily(turnCtx),
      prompt: turnCtx.prompt,
      responsePreview: result.content,
      usage: result.usage,
      contextDetail: {
        openclawPromptRoot:
          (turnCtx.metadata as Record<string, unknown> | undefined)?.openclawPromptRoot ?? undefined,
        turnTools:
          (turnCtx.metadata as Record<string, unknown> | undefined)?.turnTools ?? undefined,
        requestDetail: toSerializable(trace?.requestDetail) ?? {
          renderedPromptText: "",
          segments: [],
          metadata: {},
        },
        initialContext: {
          sessionId: trace?.initialContext?.sessionId ?? turnCtx.sessionId,
          provider: trace?.initialContext?.provider ?? turnCtx.provider,
          model: trace?.initialContext?.model ?? turnCtx.model,
          prompt: trace?.initialContext?.prompt ?? turnCtx.prompt,
          segments: toSerializable(trace?.initialContext?.segments ?? turnCtx.segments) ?? [],
          metadata: toSerializable(trace?.initialContext?.metadata ?? turnCtx.metadata) ?? {},
        },
        finalContext: {
          sessionId: trace?.finalContext?.sessionId ?? turnCtx.sessionId,
          provider: trace?.finalContext?.provider ?? turnCtx.provider,
          model: trace?.finalContext?.model ?? turnCtx.model,
          prompt: trace?.finalContext?.prompt ?? turnCtx.prompt,
          segments: toSerializable(trace?.finalContext?.segments ?? turnCtx.segments) ?? [],
          metadata: toSerializable(trace?.finalContext?.metadata ?? turnCtx.metadata) ?? {},
        },
        moduleSteps: toSerializable(trace?.moduleSteps) ?? [],
      },
      eventTypes: [...finalCtxEvents, ...resultEvents].map((e) => e.type),
      finalContextEvents: finalCtxEvents,
      resultEvents,
    };
    await mkdir(dirname(eventTracePath), { recursive: true });
    await appendFile(eventTracePath, `${JSON.stringify(payload)}\n`, "utf8");
  };

  const resolveRouting = async (ctx: RuntimeTurnContext) => {
    const logicalSessionId =
      (ctx.metadata as Record<string, unknown> | undefined)?.logicalSessionId?.toString() ?? ctx.sessionId;
    const manualBindings = await readManualBranchBindings();
    const manualPhysical = manualBindings.get(logicalSessionId);
    const existingPhysical = logicalToPhysical.get(logicalSessionId);
    const physicalSessionId = manualPhysical ?? existingPhysical ?? ctx.sessionId;
    logicalToPhysical.set(logicalSessionId, physicalSessionId);
    return { logicalSessionId, physicalSessionId };
  };

  const ensureBranchRegistered = async (params: {
    logicalSessionId: string;
    physicalSessionId: string;
    parentPhysicalSessionId?: string;
    forkedFromMessageId?: string;
    createdAt?: string;
    source: string;
    metadata?: Record<string, unknown>;
  }) => {
    const {
      logicalSessionId,
      physicalSessionId,
      parentPhysicalSessionId,
      forkedFromMessageId,
      createdAt,
      source,
      metadata,
    } = params;
    if (knownPhysicalBranches.has(physicalSessionId)) return;
    const existing = await stateStore?.listBranches(logicalSessionId);
    if (existing?.some((branch) => branch.branchId === physicalSessionId)) {
      knownPhysicalBranches.add(physicalSessionId);
      return;
    }
    await stateStore?.appendBranch({
      branchId: physicalSessionId,
      sessionId: logicalSessionId,
      parentBranchId: parentPhysicalSessionId,
      forkedFromMessageId,
      createdAt: createdAt ?? new Date().toISOString(),
      source,
      metadata,
    });
    knownPhysicalBranches.add(physicalSessionId);
  };

  const resolveBranchHeadMessageId = async (
    logicalSessionId: string,
    physicalSessionId: string,
  ): Promise<string | undefined> => {
    const cached = branchHeadMessageIdByPhysical.get(physicalSessionId);
    if (cached) return cached;
    const messages = await stateStore?.listMessages(logicalSessionId, { branchId: physicalSessionId });
    const latest = messages && messages.length > 0 ? messages[messages.length - 1] : undefined;
    if (latest?.messageId) {
      branchHeadMessageIdByPhysical.set(physicalSessionId, latest.messageId);
      return latest.messageId;
    }
    return undefined;
  };

  const persistMessages = async (records: PersistedMessageRecord[]) => {
    if (records.length === 0) return;
    await stateStore?.appendMessages(records);
    const last = records[records.length - 1];
    if (last?.messageId) {
      branchHeadMessageIdByPhysical.set(last.branchId, last.messageId);
    }
  };

  const persistObservedTurnMessages = async (params: {
    logicalSessionId: string;
    physicalSessionId: string;
    turnId: string;
    ctx: RuntimeTurnContext;
    result: RuntimeTurnResult;
    createdAt: string;
  }) => {
    const { logicalSessionId, physicalSessionId, turnId, ctx, result, createdAt } = params;
    await ensureBranchRegistered({
      logicalSessionId,
      physicalSessionId,
      createdAt,
      source: "connector-openclaw",
      metadata: {
        branchType: "provider_observed",
      },
    });
    let parentMessageId = await resolveBranchHeadMessageId(logicalSessionId, physicalSessionId);
    const records: PersistedMessageRecord[] = [];
    const promptText = String(ctx.prompt ?? "").trim();
    if (promptText) {
      const messageId = randomUUID();
      records.push({
        messageId,
        sessionId: logicalSessionId,
        branchId: physicalSessionId,
        parentMessageId,
        turnId,
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: promptText,
        createdAt,
        source: "connector-openclaw",
        metadata: {
          provider: ctx.provider,
          model: ctx.model,
        },
      });
      parentMessageId = messageId;
    }
    const responseText = String(result.content ?? "").trim();
    if (responseText) {
      const messageId = randomUUID();
      records.push({
        messageId,
        sessionId: logicalSessionId,
        branchId: physicalSessionId,
        parentMessageId,
        turnId,
        role: "assistant",
        kind: "message",
        origin: "provider_observed",
        content: responseText,
        createdAt,
        source: "connector-openclaw",
        metadata: {
          provider: ctx.provider,
          model: ctx.model,
        },
      });
    }
    await persistMessages(records);
  };

  const materializeBranchEdit = async (
    request: BranchMaterializationRequest,
    invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>,
  ): Promise<BranchMaterializationResult> => {
    const {
      logicalSessionId,
      sourcePhysicalSessionId,
      sourceContext,
      strategy,
      sourceTraceId,
      planId,
      upstreamSeed,
    } = request;
    const sourceMessageId =
      request.sourceMessageId ??
      (await resolveBranchHeadMessageId(logicalSessionId, sourcePhysicalSessionId));

    await ensureBranchRegistered({
      logicalSessionId,
      physicalSessionId: sourcePhysicalSessionId,
      createdAt: new Date().toISOString(),
      source: "connector-openclaw",
      metadata: {
        branchType: "provider_observed",
      },
    });

    forkCounter += 1;
    const newPhysical = `${physicalSessionPrefix}-${safeName(logicalSessionId)}-f${forkCounter
      .toString()
      .padStart(4, "0")}`;
    const createdAt = new Date().toISOString();

    await ensureBranchRegistered({
      logicalSessionId,
      physicalSessionId: newPhysical,
      parentPhysicalSessionId: sourcePhysicalSessionId,
      forkedFromMessageId: sourceMessageId,
      createdAt,
      source: "connector-openclaw",
      metadata: {
        branchType: "materialized",
        strategy,
        sourceTraceId,
        planId,
      },
    });

    let parentMessageId = sourceMessageId;
    const materializedMessages = request.messages
      .filter((message) => String(message.content ?? "").trim().length > 0)
      .map((message, index) => {
        const messageId = randomUUID();
        const record: PersistedMessageRecord = {
          messageId,
          sessionId: logicalSessionId,
          branchId: newPhysical,
          parentMessageId,
          role: message.role,
          kind: message.kind ?? "message",
          origin: message.origin ?? "synthetic_materialized",
          content: String(message.content ?? ""),
          createdAt: new Date(Date.parse(createdAt) + index).toISOString(),
          source: message.source ?? "connector-openclaw",
          replacesMessageIds: message.replacesMessageIds,
          derivedFromArtifactId: message.derivedFromArtifactId,
          metadata: message.metadata,
        };
        parentMessageId = messageId;
        return record;
      });
    await persistMessages(materializedMessages);
    logicalToPhysical.set(logicalSessionId, newPhysical);

    let seedUsage: RuntimeTurnResult["usage"] | undefined;
    if (upstreamSeed) {
      const seedCtx: RuntimeTurnContext = {
        ...sourceContext,
        sessionId: newPhysical,
        prompt: upstreamSeed.prompt,
        metadata: {
          ...(sourceContext.metadata ?? {}),
          ...(upstreamSeed.metadata ?? {}),
          logicalSessionId,
          physicalSessionId: newPhysical,
          forkedFromSessionId: sourcePhysicalSessionId,
          branchStrategy: strategy,
          planId,
          policyBypass: true,
        },
        segments: [
          ...sourceContext.segments.filter((segment) => segment.kind === "stable"),
          ...upstreamSeed.segments,
        ],
      };
      const seedStartedAt = new Date().toISOString();
      const seedResult = await pipeline.run(seedCtx, invokeModel);
      seedUsage = seedResult.usage;
      await stateStore?.appendTurn({
        turnId: randomUUID(),
        sessionId: newPhysical,
        provider: seedCtx.provider,
        model: seedCtx.model,
        apiFamily: seedCtx.apiFamily ?? resolveApiFamily(seedCtx),
        prompt: seedCtx.prompt,
        segments: seedCtx.segments,
        usage: seedResult.usage,
        responsePreview: seedResult.content,
        response: seedResult.content,
        trace: toSerializable<RuntimeTurnTrace | undefined>(
          (seedResult.metadata as Record<string, unknown> | undefined)?.ecoclawTrace as
            | RuntimeTurnTrace
            | undefined,
        ),
        resultMetadata: toSerializable(seedResult.metadata),
        startedAt: seedStartedAt,
        endedAt: new Date().toISOString(),
        status: "ok",
      });
    }

    return {
      applied: true,
      logicalSessionId,
      fromPhysicalSessionId: sourcePhysicalSessionId,
      toPhysicalSessionId: newPhysical,
      branchId: newPhysical,
      strategy,
      sourceTraceId,
      sourceMessageId,
      planId,
      messageIds: materializedMessages.map((message) => message.messageId),
      materializedMessageCount: materializedMessages.length,
      headMessageId: materializedMessages[materializedMessages.length - 1]?.messageId ?? sourceMessageId,
      seedUsage,
    };
  };

  const maybeApplyCompactionPlan = async (
    logicalSessionId: string,
    physicalSessionId: string,
    ctx: RuntimeTurnContext,
    result: RuntimeTurnResult,
    invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>,
  ) => {
    if (!autoForkOnPolicy) return { applied: false, reason: "auto_fork_disabled" } as const;
    const resultMeta = (result.metadata ?? {}) as Record<string, unknown>;
    const planEvents = findRuntimeEventsByType(resultMeta, ECOCLAW_EVENT_TYPES.COMPACTION_PLAN_GENERATED);
    if (planEvents.length === 0) {
      return { applied: false, reason: "no_compaction_plan" } as const;
    }

    const latestPlan = planEvents[planEvents.length - 1];
    const planPayload = (latestPlan.payload ?? {}) as Record<string, unknown>;
    const seedSummary = String(planPayload.seedSummary ?? "").trim();
    if (!seedSummary) return { applied: false, reason: "empty_seed_summary" } as const;
    const summaryChars =
      typeof planPayload.summaryChars === "number" && Number.isFinite(planPayload.summaryChars)
        ? planPayload.summaryChars
        : seedSummary.length;
    const strategy =
      typeof planPayload.strategy === "string" && planPayload.strategy.trim().length > 0
        ? planPayload.strategy
        : "summary_then_fork";
    const planId =
      typeof planPayload.planId === "string" && planPayload.planId.trim().length > 0
        ? planPayload.planId
        : undefined;
    const compactionId =
      typeof planPayload.compactionId === "string" && planPayload.compactionId.trim().length > 0
        ? planPayload.compactionId
        : undefined;

    const materialized = await materializeBranchEdit(
      {
        logicalSessionId,
        sourcePhysicalSessionId: physicalSessionId,
        sourceContext: ctx,
        strategy,
        planId,
        messages: [
          {
            role: "system",
            kind: "checkpoint_seed",
            origin: "derived_artifact",
            content: seedSummary,
            source: "module-compaction",
            derivedFromArtifactId: compactionId,
            metadata: {
              summaryChars,
              strategy,
            },
          },
        ],
        upstreamSeed: {
          prompt: "[seed] Continue with compacted context summary.",
          segments: [
            {
              id: "fork-seed-summary",
              kind: "stable",
              text: `SEED_SUMMARY\n${seedSummary}`,
              priority: 2,
              source: "policy-fork",
            },
          ],
          metadata: {
            forkSeedSummaryChars: summaryChars,
          },
        },
      },
      invokeModel,
    );

    await stateStore?.writeSummary(materialized.toPhysicalSessionId, seedSummary, "compaction-seed");
    return {
      applied: true,
      newPhysical: materialized.toPhysicalSessionId,
      fromPhysical: materialized.fromPhysicalSessionId,
      summaryChars,
      seedUsage: materialized.seedUsage,
      planId: materialized.planId,
      strategy: materialized.strategy,
      branchMaterialization: materialized,
    } as const;
  };

  return {
    // Placeholder: wire these to OpenClaw plugin hooks.
    async onBeforePromptBuild(ctx: any) {
      return ctx;
    },
    async onLlmCall(turnCtx: RuntimeTurnContext, invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>) {
      const startedAt = new Date().toISOString();
      const observationSegments = buildObservationSegments(turnCtx);
      const { logicalSessionId, physicalSessionId } = await resolveRouting(turnCtx);
      const contextView =
        stateStore
          ? buildContextViewSnapshot(
              await buildContextSessionView({
                store: stateStore,
                sessionId: logicalSessionId,
                activeBranchId: physicalSessionId,
              }),
            )
          : undefined;
      const routedCtx: RuntimeTurnContext = {
        ...turnCtx,
        sessionId: physicalSessionId,
        segments:
          observationSegments.length > 0
            ? [...turnCtx.segments, ...observationSegments]
            : turnCtx.segments,
        metadata: {
          ...(turnCtx.metadata ?? {}),
          logicalSessionId,
          physicalSessionId,
          observationSegmentCount: observationSegments.length,
          ...(contextView ? { contextView } : {}),
        },
      };
      try {
        const result = await pipeline.run(routedCtx, invokeModel);
        const forkOutcome = await maybeApplyCompactionPlan(
          logicalSessionId,
          physicalSessionId,
          routedCtx,
          result,
          invokeModel,
        );
        if (forkOutcome.applied) {
          const usage = result.usage ?? {};
          const payload = {
            strategy: forkOutcome.strategy,
            logicalSessionId,
            fromPhysicalSessionId: forkOutcome.fromPhysical,
            toPhysicalSessionId: forkOutcome.newPhysical,
            summaryChars: forkOutcome.summaryChars,
            planId: forkOutcome.planId,
            materializedMessageCount:
              forkOutcome.branchMaterialization?.materializedMessageCount ?? undefined,
            sourceMessageId: forkOutcome.branchMaterialization?.sourceMessageId ?? undefined,
            compactionTurn: {
              promptTokens:
                typeof usage.inputTokens === "number"
                  ? usage.inputTokens
                  : undefined,
              completionTokens:
                typeof usage.outputTokens === "number"
                  ? usage.outputTokens
                  : undefined,
              cacheReadTokens:
                typeof usage.cacheReadTokens === "number"
                  ? usage.cacheReadTokens
                  : typeof usage.cachedTokens === "number"
                    ? usage.cachedTokens
                    : undefined,
            },
            seedUsage: forkOutcome.seedUsage,
          };
          result.metadata = appendRuntimeEvent(
            (result.metadata ?? {}) as Record<string, unknown>,
            {
              type: ECOCLAW_EVENT_TYPES.BRANCH_MATERIALIZED,
              source: "connector-openclaw",
              at: new Date().toISOString(),
              payload,
            },
          );
          result.metadata = appendRuntimeEvent(
            (result.metadata ?? {}) as Record<string, unknown>,
            {
              type: ECOCLAW_EVENT_TYPES.COMPACTION_APPLY_EXECUTED,
              source: "connector-openclaw",
              at: new Date().toISOString(),
              payload,
            },
          );
          result.metadata = {
            ...(result.metadata ?? {}),
            branchMaterialization: payload,
            compactionApply: payload,
          };
        }
        const endedAt = new Date().toISOString();
        await appendEventTrace(logicalSessionId, physicalSessionId, routedCtx, result);
        const turnId = randomUUID();
        await stateStore?.appendTurn({
          turnId,
          sessionId: routedCtx.sessionId,
          provider: routedCtx.provider,
          model: routedCtx.model,
          apiFamily: routedCtx.apiFamily ?? resolveApiFamily(routedCtx),
          prompt: routedCtx.prompt,
          segments: routedCtx.segments,
          usage: result.usage,
          responsePreview: result.content,
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
        await persistObservedTurnMessages({
          logicalSessionId,
          physicalSessionId,
          turnId,
          ctx: routedCtx,
          result,
          createdAt: endedAt,
        });
        return result;
      } catch (err) {
        const endedAt = new Date().toISOString();
        await stateStore?.appendTurn({
          turnId: randomUUID(),
          sessionId: routedCtx.sessionId,
          provider: routedCtx.provider,
          model: routedCtx.model,
          apiFamily: routedCtx.apiFamily ?? resolveApiFamily(routedCtx),
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
    async materializeBranchEdit(
      request: BranchMaterializationRequest,
      invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>,
    ) {
      return materializeBranchEdit(request, invokeModel);
    },
    getStateRootDir() {
      return cfg.stateDir ? `${cfg.stateDir}/ecoclaw` : undefined;
    },
    getPhysicalSessionId(logicalSessionId: string) {
      return logicalToPhysical.get(logicalSessionId);
    },
  };
}
