import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  type RuntimeModule,
} from "@ecoclaw/kernel";
import {
  readReductionMetadata,
  resolveReductionPasses,
  runReductionAfterCall,
  runReductionBeforeCall,
} from "./pipeline.js";
import type {
  ReductionMetadata,
  ReductionModuleConfig,
  ReductionSummary,
  ReductionPassSpec,
  ReductionReportEntry,
} from "./types.js";

export * from "./types.js";
export * from "./registry.js";
export * from "./pipeline.js";
export * from "./pass-tool-payload-trim.js";
export * from "./pass-format-slimming.js";
export * from "./pass-semantic-llmlingua2.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function selectReductionPassesForPhase(
  passes: ReductionPassSpec[],
  metadata: Record<string, unknown> | undefined,
  phase: "before_call" | "after_call",
): ReductionPassSpec[] {
  const policy = asRecord(metadata?.policy);
  if (policy?.version !== "v2" || policy?.mode !== "online") {
    return passes;
  }

  const decisions = asRecord(policy.decisions);
  const reduction = asRecord(decisions?.reduction);
  if (!reduction || reduction.enabled !== true) {
    return [];
  }

  const key = phase === "before_call" ? "beforeCallPassIds" : "afterCallPassIds";
  const plannedIds = Array.isArray(reduction[key])
    ? new Set(reduction[key].map((value) => String(value ?? "")))
    : new Set<string>();

  return passes.filter((pass) => plannedIds.has(String(pass.id)));
}

function summarizeReductionReport(report: ReductionReportEntry[], fallbackChars: number): ReductionSummary {
  const first = report[0];
  const last = report[report.length - 1];
  const beforeChars = first?.beforeChars ?? fallbackChars;
  const afterChars = last?.afterChars ?? fallbackChars;
  const changedPassCount = report.filter((entry) => entry.changed).length;
  const skippedPassCount = report.filter((entry) => entry.skippedReason).length;
  const passBreakdown = report.map((entry, index) => {
    const entryBefore = entry.beforeChars;
    const entryAfter = entry.afterChars;
    const savedChars = Math.max(0, entryBefore - entryAfter);
    const savingsRatio = entryBefore > 0 ? Number((savedChars / entryBefore).toFixed(4)) : 0;
    const cumulativeSavedChars = Math.max(0, beforeChars - entryAfter);
    return {
      id: entry.id,
      phase: entry.phase,
      target: entry.target,
      order: index + 1,
      changed: entry.changed,
      skippedReason: entry.skippedReason,
      note: entry.note,
      beforeChars: entryBefore,
      afterChars: entryAfter,
      savedChars,
      savingsRatio,
      cumulativeSavedChars,
      touchedSegmentIds: entry.touchedSegmentIds,
    };
  });
  const topContributor =
    passBreakdown
      .filter((entry) => entry.savedChars > 0)
      .sort((a, b) => b.savedChars - a.savedChars)[0] ?? null;
  const totalSavedChars = Math.max(0, beforeChars - afterChars);
  const totalSavingsRatio = beforeChars > 0 ? Number((totalSavedChars / beforeChars).toFixed(4)) : 0;
  return {
    beforeChars,
    afterChars,
    savedChars: totalSavedChars,
    savingsRatio: totalSavingsRatio,
    changedPassCount,
    skippedPassCount,
    passCount: report.length,
    topContributor,
    passBreakdown,
    report,
  };
}

export function createReductionModule(cfg: ReductionModuleConfig = {}): RuntimeModule {
  const allPasses = resolveReductionPasses(cfg);

  return {
    name: "module-reduction",
    async beforeCall(ctx) {
      const passes = selectReductionPassesForPhase(allPasses, ctx.metadata, "before_call");
      const { turnCtx: reducedCtx, report } = await runReductionBeforeCall({
        turnCtx: ctx,
        passes,
        registry: cfg.registry,
      });
      const prior = readReductionMetadata(reducedCtx.metadata);
      const metadata: ReductionMetadata = {
        beforeCall: report,
        afterCall: prior.afterCall,
      };
      const fallbackChars = ctx.segments.reduce((sum, segment) => sum + segment.text.length, 0);
      const reductionSummary = summarizeReductionReport(report, fallbackChars);
      const nextCtx = {
        ...reducedCtx,
        metadata: {
          ...(reducedCtx.metadata ?? {}),
          reduction: {
            ...metadata,
            beforeCallSummary: reductionSummary,
          },
        },
      };
      return appendContextEvent(
        nextCtx,
        {
          type: ECOCLAW_EVENT_TYPES.REDUCTION_BEFORE_CALL_RECORDED,
          source: "module-reduction",
          at: new Date().toISOString(),
          payload: reductionSummary,
        },
      );
    },
    async afterCall(ctx, result) {
      const passes = selectReductionPassesForPhase(allPasses, ctx.metadata, "after_call");
      const { result: reducedResult, report } = await runReductionAfterCall({
        turnCtx: ctx,
        result,
        passes,
        registry: cfg.registry,
      });
      const prior = readReductionMetadata(ctx.metadata);
      const metadata: ReductionMetadata = {
        beforeCall: prior.beforeCall,
        afterCall: report,
      };
      const reductionSummary = summarizeReductionReport(report, result.content.length);

      const nextResult = {
        ...reducedResult,
        metadata: {
          ...(reducedResult.metadata ?? {}),
          reduction: {
            ...metadata,
            beforeCallSummary: prior.beforeCall
              ? summarizeReductionReport(
                  prior.beforeCall,
                  ctx.segments.reduce((sum, segment) => sum + segment.text.length, 0),
                )
              : undefined,
            afterCallSummary: reductionSummary,
          },
        },
      };
      return appendResultEvent(
        nextResult,
        {
          type: ECOCLAW_EVENT_TYPES.REDUCTION_AFTER_CALL_RECORDED,
          source: "module-reduction",
          at: new Date().toISOString(),
          payload: reductionSummary,
        },
      );
    },
  };
}
