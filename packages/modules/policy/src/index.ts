import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeTurnContext,
  type RuntimeModule,
} from "@ecoclaw/kernel";

export type PolicyModuleConfig = {
  summaryTriggerInputTokens?: number;
  summaryTriggerStableChars?: number;
  ttlSoonSeconds?: number;
  cacheJitterWindowTurns?: number;
  cacheMissRateThreshold?: number;
  minTurnsBeforeJitter?: number;
  requestCooldownTurns?: number;
};

export function createPolicyModule(cfg: PolicyModuleConfig = {}): RuntimeModule {
  const summaryTriggerInputTokens = Math.max(0, cfg.summaryTriggerInputTokens ?? 20000);
  const summaryTriggerStableChars = Math.max(0, cfg.summaryTriggerStableChars ?? 0);
  const ttlSoonSeconds = Math.max(10, cfg.ttlSoonSeconds ?? 120);
  const cacheJitterWindowTurns = Math.max(3, cfg.cacheJitterWindowTurns ?? 6);
  const cacheMissRateThreshold = Math.min(1, Math.max(0, cfg.cacheMissRateThreshold ?? 0.5));
  const minTurnsBeforeJitter = Math.max(1, cfg.minTurnsBeforeJitter ?? 4);
  const requestCooldownTurns = Math.max(0, cfg.requestCooldownTurns ?? 2);
  const stateBySession = new Map<
    string,
    {
      turn: number;
      lastSummaryRequestTurn?: number;
      recentCacheReadHit: number[];
      cumulativeInputTokens: number;
    }
  >();

  const readInputTokens = (usage: any): number => {
    const toNum = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
      return undefined;
    };
    const direct = toNum(usage?.inputTokens);
    if (direct !== undefined) return direct;
    const raw = usage?.providerRaw as Record<string, unknown> | undefined;
    const rawInput = toNum(raw?.input_tokens ?? raw?.prompt_tokens ?? raw?.inputTokens ?? raw?.promptTokens);
    return rawInput ?? 0;
  };

  return {
    name: "module-policy",
    async beforeBuild(ctx) {
      const state = stateBySession.get(ctx.sessionId) ?? {
        turn: 0,
        recentCacheReadHit: [],
        cumulativeInputTokens: 0,
      };
      const stableChars = ctx.segments
        .filter((s) => s.kind === "stable")
        .map((s) => s.text)
        .join("\n").length;
      const cacheMeta = (ctx.metadata?.cache as Record<string, unknown> | undefined) ?? {};
      const cacheEligible = Boolean(cacheMeta.eligible);
      const treeMeta = (cacheMeta.tree as Record<string, unknown> | undefined) ?? {};
      const selectedCandidate = Array.isArray(treeMeta.candidates) ? treeMeta.candidates[0] : undefined;
      const selectedExpiresAt = (selectedCandidate as Record<string, unknown> | undefined)?.expiresAt;
      const expiresSoon =
        typeof selectedExpiresAt === "string"
          ? new Date(selectedExpiresAt).getTime() - Date.now() <= ttlSoonSeconds * 1000
          : false;

      const recent = state.recentCacheReadHit.slice(-cacheJitterWindowTurns);
      const missCount = recent.filter((v) => v === 0).length;
      const missRate = recent.length > 0 ? missCount / recent.length : 0;
      const jitterTriggered =
        state.turn >= minTurnsBeforeJitter &&
        recent.length >= Math.min(cacheJitterWindowTurns, minTurnsBeforeJitter) &&
        missRate >= cacheMissRateThreshold;

      const reasons: string[] = [];
      if (cacheEligible && summaryTriggerInputTokens > 0 && state.cumulativeInputTokens >= summaryTriggerInputTokens) {
        reasons.push("input_tokens_threshold");
      }
      if (cacheEligible && summaryTriggerStableChars > 0 && stableChars >= summaryTriggerStableChars) {
        reasons.push("stable_chars_threshold");
      }
      if (cacheEligible && expiresSoon) {
        reasons.push("cache_ttl_soon");
      }
      if (cacheEligible && jitterTriggered) {
        reasons.push("cache_jitter");
      }
      const shouldRequestSummary = reasons.length > 0;
      const cooldownActive =
        typeof state.lastSummaryRequestTurn === "number" &&
        state.turn - state.lastSummaryRequestTurn <= requestCooldownTurns;
      const finalRequest = shouldRequestSummary && !cooldownActive;

      const withMeta = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          policy: {
            summaryTriggerInputTokens,
            summaryTriggerStableChars,
            ttlSoonSeconds,
            cacheJitterWindowTurns,
            cacheMissRateThreshold,
            stableChars,
            cumulativeInputTokens: state.cumulativeInputTokens,
            shouldRequestSummary: finalRequest,
            reasons,
            recentCacheMissRate: missRate,
            cacheExpiresSoon: expiresSoon,
            cooldownActive,
          },
        },
      };
      let nextCtx: RuntimeTurnContext = withMeta;
      if (jitterTriggered) {
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_CACHE_JITTER_DETECTED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            missRate,
            missCount,
            recentWindowSize: recent.length,
            threshold: cacheMissRateThreshold,
          },
        });
      }
      if (!finalRequest) {
        return nextCtx;
      }
      state.lastSummaryRequestTurn = state.turn;
      stateBySession.set(ctx.sessionId, state);
      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
        source: "module-policy",
        at: new Date().toISOString(),
        payload: {
          cumulativeInputTokens: state.cumulativeInputTokens,
          stableChars,
          reasons,
          inputTokensThreshold: summaryTriggerInputTokens,
          threshold: summaryTriggerStableChars,
          ttlSoonSeconds,
          missRate,
        },
      });
    },
    async afterCall(ctx, result) {
      const state = stateBySession.get(ctx.sessionId) ?? {
        turn: 0,
        recentCacheReadHit: [],
        cumulativeInputTokens: 0,
      };
      state.turn += 1;
      const readTokens = result.usage?.cacheReadTokens ?? result.usage?.cachedTokens ?? 0;
      state.cumulativeInputTokens += readInputTokens(result.usage);
      state.recentCacheReadHit.push(readTokens > 0 ? 1 : 0);
      if (state.recentCacheReadHit.length > cacheJitterWindowTurns * 3) {
        state.recentCacheReadHit = state.recentCacheReadHit.slice(-cacheJitterWindowTurns * 3);
      }
      stateBySession.set(ctx.sessionId, state);

      const summaryEvents = findRuntimeEventsByType(result.metadata, ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED);
      if (summaryEvents.length === 0) return result;
      const latest = summaryEvents[summaryEvents.length - 1];
      return appendResultEvent(result, {
        type: ECOCLAW_EVENT_TYPES.POLICY_FORK_RECOMMENDED,
        source: "module-policy",
        at: new Date().toISOString(),
        payload: {
          strategy: "fork_from_summary",
          targetBranch: (latest.payload as Record<string, unknown>)?.targetBranch,
        },
      });
    },
  };
}
