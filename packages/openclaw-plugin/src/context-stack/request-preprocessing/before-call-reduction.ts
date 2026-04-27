/* eslint-disable @typescript-eslint/no-explicit-any */
import { resolveReductionPasses, runReductionBeforeCall } from "../../execution/reduction/pipeline.js";
import type { ContextSegment } from "../../../../kernel/src/types.js";
import type { RuntimeModule } from "../../../../kernel/src/interfaces.js";

export type BeforeCallPassToggles = {
  repeatedReadDedup?: boolean;
  toolPayloadTrim?: boolean;
  htmlSlimming?: boolean;
  execOutputTruncation?: boolean;
  agentsStartupOptimization?: boolean;
};

export type ProxyReductionResult = {
  changedItems: number;
  changedBlocks: number;
  savedChars: number;
  report?: Array<{
    id: string;
    phase: string;
    target: string;
    changed: boolean;
    note?: string;
    skippedReason?: string;
    beforeChars: number;
    afterChars: number;
    touchedSegmentIds?: string[];
  }>;
  diagnostics?: {
    engine: "layered";
    inputItems: number;
    toolLikeItems: number;
    persistedSkippedItems?: number;
    candidateBlocks: number;
    overThresholdBlocks: number;
    triggerMinChars: number;
    maxToolChars: number;
    instructionCount: number;
    passCount: number;
    policyChangedSegments?: number;
    skippedReason?: string;
  };
};

type ReductionBinding = {
  itemIndex: number;
  field: "content" | "arguments" | "output" | "result";
  blockIndex?: number;
  blockKey?: string;
  beforeLen: number;
  segmentId: string;
};

type BuildReductionContextResult = {
  turnCtx: { segments: ContextSegment[] };
  bindings: ReductionBinding[];
  stats: {
    inputItems: number;
    toolLikeItems: number;
    persistedSkippedItems: number;
    candidateBlocks: number;
    overThresholdBlocks: number;
    instructionCount: number;
  };
};

type BeforeCallHelpers = {
  applyPolicyBeforeCall: (
    turnCtx: any,
    cfg: any,
    logger: any,
    beforeCallModules: {
      policy?: RuntimeModule;
      eviction?: RuntimeModule;
    },
  ) => Promise<{ turnCtx: any; policyChangedSegmentIds: string[] }>;
  buildLayeredReductionContext: (
    payload: any,
    triggerMinChars: number,
    sessionId: string,
    passToggles?: BeforeCallPassToggles,
    passOptions?: Record<string, Record<string, unknown>>,
    segmentAnchorByCallId?: Map<string, { turnAbsIds: string[]; taskIds: string[] }>,
    orderedTurnAnchors?: Array<{ turnAbsId: string; taskIds: string[] }>,
  ) => BuildReductionContextResult;
  isReductionPassEnabled: (passId: string, passToggles?: BeforeCallPassToggles) => boolean;
  loadOrderedTurnAnchors: (
    stateDir: string,
    sessionId: string,
  ) => Promise<Array<{ turnAbsId: string; taskIds: string[] }>>;
  loadSegmentAnchorByCallId: (
    stateDir: string,
    sessionId: string,
  ) => Promise<Map<string, { turnAbsIds: string[]; taskIds: string[] }>>;
  makeLogger: () => any;
};

export async function applyLayeredReductionToInput(
  payload: any,
  maxToolChars: number,
  triggerMinChars: number,
  sessionId: string,
  logger: any,
  passToggles: BeforeCallPassToggles | undefined,
  passOptions: Record<string, Record<string, unknown>> | undefined,
  beforeCallModules: { policy?: RuntimeModule; eviction?: RuntimeModule } | undefined,
  cfg: any,
  helpers: BeforeCallHelpers,
): Promise<ProxyReductionResult> {
  if (!Array.isArray(payload?.input)) {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      diagnostics: {
        engine: "layered",
        inputItems: 0,
        toolLikeItems: 0,
        candidateBlocks: 0,
        overThresholdBlocks: 0,
        triggerMinChars,
        maxToolChars,
        instructionCount: 0,
        passCount: 0,
        skippedReason: "no_input_array",
      },
    };
  }
  const segmentAnchorByCallId =
    cfg?.stateDir && sessionId && sessionId !== "proxy-session"
      ? await helpers.loadSegmentAnchorByCallId(cfg.stateDir, sessionId).catch(() => new Map())
      : undefined;
  const orderedTurnAnchors =
    cfg?.stateDir && sessionId && sessionId !== "proxy-session"
      ? await helpers.loadOrderedTurnAnchors(cfg.stateDir, sessionId).catch(() => [])
      : undefined;
  const { turnCtx, bindings, stats } = helpers.buildLayeredReductionContext(
    payload,
    triggerMinChars,
    sessionId,
    passToggles,
    passOptions,
    segmentAnchorByCallId,
    orderedTurnAnchors,
  );
  if (turnCtx.segments.length === 0 || bindings.length === 0) {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      diagnostics: {
        engine: "layered",
        inputItems: stats.inputItems,
        toolLikeItems: stats.toolLikeItems,
        persistedSkippedItems: stats.persistedSkippedItems,
        candidateBlocks: stats.candidateBlocks,
        overThresholdBlocks: stats.overThresholdBlocks,
        triggerMinChars,
        maxToolChars,
        instructionCount: stats.instructionCount,
        passCount: 0,
        skippedReason: stats.candidateBlocks === 0 ? "no_candidate_blocks" : "below_trigger_min_chars",
      },
    };
  }
  const beforeCallCtxPromise = beforeCallModules && cfg
    ? helpers.applyPolicyBeforeCall(turnCtx, cfg, logger, beforeCallModules)
    : Promise.resolve({ turnCtx, policyChangedSegmentIds: [] as string[] });

  const passes = resolveReductionPasses({ maxToolChars, passOptions }).filter(
    (p) => p.phase === "before_call" && helpers.isReductionPassEnabled(p.id, passToggles),
  );
  return beforeCallCtxPromise.then(({ turnCtx: preReductionCtx, policyChangedSegmentIds }) =>
    runReductionBeforeCall({
      turnCtx: preReductionCtx,
      passes,
    }).then(({ turnCtx: reducedCtx, report }) => {
      const changedIds = new Set<string>();
      for (const entry of report) {
        if (!entry.changed) continue;
        for (const id of entry.touchedSegmentIds ?? []) changedIds.add(id);
      }
      for (const id of policyChangedSegmentIds) changedIds.add(id);
      if (changedIds.size === 0) {
        return {
          changedItems: 0,
          changedBlocks: 0,
          savedChars: 0,
          report,
          diagnostics: {
            engine: "layered" as const,
            inputItems: stats.inputItems,
            toolLikeItems: stats.toolLikeItems,
            persistedSkippedItems: stats.persistedSkippedItems,
            candidateBlocks: stats.candidateBlocks,
            overThresholdBlocks: stats.overThresholdBlocks,
            triggerMinChars,
            maxToolChars,
            instructionCount: stats.instructionCount,
            passCount: passes.length,
            skippedReason: "pipeline_no_effect",
          },
        };
      }
      const segmentMap = new Map<string, ContextSegment>();
      for (const segment of reducedCtx.segments) segmentMap.set(segment.id, segment);

      let changedBlocks = 0;
      let savedChars = 0;
      const changedItems = new Set<number>();

      for (const binding of bindings) {
        if (!changedIds.has(binding.segmentId)) continue;
        const reduced = segmentMap.get(binding.segmentId);
        if (!reduced) continue;
        const nextText = reduced.text;
        if (binding.field === "arguments" || binding.field === "output" || binding.field === "result") {
          const item = payload.input[binding.itemIndex];
          if (!item || typeof item !== "object") continue;
          if (typeof item[binding.field] !== "string") continue;
          if (item[binding.field] === nextText) continue;
          item[binding.field] = nextText;
        } else if (binding.field === "content") {
          const item = payload.input[binding.itemIndex];
          if (!item || typeof item !== "object") continue;
          if (binding.blockIndex === undefined) {
            if (typeof item.content !== "string") continue;
            if (item.content === nextText) continue;
            item.content = nextText;
          } else {
            if (!Array.isArray(item.content)) continue;
            const block = item.content[binding.blockIndex];
            if (!block || typeof block !== "object" || !binding.blockKey) continue;
            if (typeof (block as any)[binding.blockKey] !== "string") continue;
            if ((block as any)[binding.blockKey] === nextText) continue;
            (block as any)[binding.blockKey] = nextText;
          }
        }
        changedItems.add(binding.itemIndex);
        changedBlocks += 1;
        savedChars += Math.max(0, binding.beforeLen - nextText.length);
      }
      return {
        changedItems: changedItems.size,
        changedBlocks,
        savedChars,
        report,
        diagnostics: {
          engine: "layered" as const,
          inputItems: stats.inputItems,
          toolLikeItems: stats.toolLikeItems,
          persistedSkippedItems: stats.persistedSkippedItems,
          candidateBlocks: stats.candidateBlocks,
          overThresholdBlocks: stats.overThresholdBlocks,
          triggerMinChars,
          maxToolChars,
          instructionCount: stats.instructionCount,
          passCount: passes.length,
            policyChangedSegments: policyChangedSegmentIds.length,
        },
      };
    }),
  ).catch(() => {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      diagnostics: {
        engine: "layered" as const,
        inputItems: stats.inputItems,
        toolLikeItems: stats.toolLikeItems,
        persistedSkippedItems: stats.persistedSkippedItems,
        candidateBlocks: stats.candidateBlocks,
        overThresholdBlocks: stats.overThresholdBlocks,
        triggerMinChars,
        maxToolChars,
        instructionCount: stats.instructionCount,
        passCount: passes.length,
        skippedReason: "pipeline_error",
      },
    };
  });
}

export function applyProxyReductionToInput(
  payload: any,
  options: {
    sessionId?: string;
    engine?: "layered";
    logger?: any;
    triggerMinChars?: number;
    maxToolChars?: number;
    passToggles?: BeforeCallPassToggles;
    passOptions?: Record<string, Record<string, unknown>>;
    beforeCallModules?: {
      policy?: RuntimeModule;
      eviction?: RuntimeModule;
    };
    cfg?: any;
  } | undefined,
  helpers: BeforeCallHelpers,
): Promise<ProxyReductionResult> {
  const triggerMinChars = Math.max(256, options?.triggerMinChars ?? 2200);
  const maxToolChars = Math.max(256, options?.maxToolChars ?? 1200);
  return applyLayeredReductionToInput(
    payload,
    maxToolChars,
    triggerMinChars,
    String(options?.sessionId ?? "proxy-session"),
    options?.logger ?? helpers.makeLogger(),
    options?.passToggles,
    options?.passOptions,
    options?.beforeCallModules,
    options?.cfg,
    helpers,
  );
}
