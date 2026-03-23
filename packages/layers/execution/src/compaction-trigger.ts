import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  resolveApiFamily,
  type RuntimeModule,
  type RuntimeTurnContext,
} from "@ecoclaw/kernel";

export type CompactionTriggerModuleConfig = {
  enabled?: boolean;
  triggerInputTokens?: number;
  triggerTurnCount?: number;
  missRateThreshold?: number;
  missRateWindowTurns?: number;
  minTurnsForMissRate?: number;
  cooldownTurns?: number;
};

type SessionState = {
  turn: number;
  cumulativeInputTokens: number;
  recentMissBits: number[];
  lastTriggeredTurn?: number;
};

const toNum = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

const readInputTokens = (usage: Record<string, unknown> | undefined): number => {
  const direct = toNum(usage?.inputTokens);
  if (direct !== undefined) return direct;
  const raw = usage?.providerRaw as Record<string, unknown> | undefined;
  return toNum(raw?.input_tokens ?? raw?.prompt_tokens ?? raw?.inputTokens ?? raw?.promptTokens) ?? 0;
};

const readCacheReadTokens = (usage: Record<string, unknown> | undefined): number | undefined => {
  const direct = toNum(usage?.cacheReadTokens ?? usage?.cachedTokens);
  if (direct !== undefined) return direct;
  const raw = usage?.providerRaw as Record<string, unknown> | undefined;
  return toNum(
    raw?.cache_read_input_tokens ??
      raw?.cacheReadInputTokens ??
      (raw?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
  );
};

export function createCompactionTriggerModule(cfg: CompactionTriggerModuleConfig = {}): RuntimeModule {
  const enabled = cfg.enabled ?? true;
  const triggerInputTokens = Math.max(0, cfg.triggerInputTokens ?? 120000);
  const triggerTurnCount = Math.max(1, cfg.triggerTurnCount ?? 18);
  const missRateThreshold = Math.min(1, Math.max(0, cfg.missRateThreshold ?? 0.7));
  const missRateWindowTurns = Math.max(3, cfg.missRateWindowTurns ?? 8);
  const minTurnsForMissRate = Math.max(1, cfg.minTurnsForMissRate ?? 6);
  const cooldownTurns = Math.max(0, cfg.cooldownTurns ?? 6);

  const stateBySession = new Map<string, SessionState>();

  return {
    name: "module-compaction-trigger",
    async beforeBuild(ctx) {
      const apiFamily = resolveApiFamily(ctx);
      const state =
        stateBySession.get(ctx.sessionId) ??
        ({
          turn: 0,
          cumulativeInputTokens: 0,
          recentMissBits: [],
        } satisfies SessionState);

      const supported = apiFamily === "openai-responses";
      const recent = state.recentMissBits.slice(-missRateWindowTurns);
      const missRate = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;

      const reasons: string[] = [];
      if (supported && state.cumulativeInputTokens >= triggerInputTokens) reasons.push("input_tokens_threshold");
      if (supported && state.turn >= triggerTurnCount) reasons.push("turn_count_threshold");
      if (
        supported &&
        state.turn >= minTurnsForMissRate &&
        recent.length >= Math.min(minTurnsForMissRate, missRateWindowTurns) &&
        missRate >= missRateThreshold
      ) {
        reasons.push("cache_miss_rate_threshold");
      }

      const cooldownActive =
        typeof state.lastTriggeredTurn === "number" &&
        state.turn - state.lastTriggeredTurn <= cooldownTurns;
      const shouldRecommend = enabled && supported && reasons.length > 0 && !cooldownActive;

      let nextCtx: RuntimeTurnContext = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          compactionTrigger: {
            enabled,
            supported,
            apiFamily,
            state: {
              turn: state.turn,
              cumulativeInputTokens: state.cumulativeInputTokens,
              missRate,
              recentWindowSize: recent.length,
            },
            thresholds: {
              triggerInputTokens,
              triggerTurnCount,
              missRateThreshold,
              missRateWindowTurns,
              minTurnsForMissRate,
              cooldownTurns,
            },
            reasons,
            cooldownActive,
            shouldRecommend,
          },
        },
      };

      nextCtx = appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.COMPACTION_TRIGGER_EVALUATED,
        source: "module-compaction-trigger",
        at: new Date().toISOString(),
        payload: {
          supported,
          apiFamily,
          enabled,
          reasons,
          cooldownActive,
          shouldRecommend,
          state: {
            turn: state.turn,
            cumulativeInputTokens: state.cumulativeInputTokens,
            missRate,
            recentWindowSize: recent.length,
          },
        },
      });

      if (!shouldRecommend) {
        stateBySession.set(ctx.sessionId, state);
        return nextCtx;
      }

      state.lastTriggeredTurn = state.turn;
      stateBySession.set(ctx.sessionId, state);

      nextCtx = appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.COMPACTION_TRIGGER_RECOMMENDED,
        source: "module-compaction-trigger",
        at: new Date().toISOString(),
        payload: {
          reasons,
          apiFamily,
          strategy: "summary_then_fork",
        },
      });
      nextCtx = appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.COMPACTION_APPLY_REQUESTED,
        source: "module-compaction-trigger",
        at: new Date().toISOString(),
        payload: {
          reasons,
          apiFamily,
          strategy: "summary_then_fork",
          expectedAction: "fork_new_physical_session_with_seed_summary",
        },
      });

      // Reuse existing summary/fork chain: summary module listens for POLICY_SUMMARY_REQUESTED.
      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
        source: "module-compaction-trigger",
        at: new Date().toISOString(),
        payload: {
          reasons: ["compaction_trigger", ...reasons],
          via: "module-compaction-trigger",
          apiFamily,
        },
      });
    },

    async afterCall(ctx, result) {
      const state =
        stateBySession.get(ctx.sessionId) ??
        ({
          turn: 0,
          cumulativeInputTokens: 0,
          recentMissBits: [],
        } satisfies SessionState);

      state.turn += 1;
      state.cumulativeInputTokens += readInputTokens((result.usage ?? {}) as Record<string, unknown>);

      const cacheRead = readCacheReadTokens((result.usage ?? {}) as Record<string, unknown>);
      if (cacheRead !== undefined) {
        const missBit = cacheRead > 0 ? 0 : 1;
        state.recentMissBits.push(missBit);
        if (state.recentMissBits.length > missRateWindowTurns * 3) {
          state.recentMissBits = state.recentMissBits.slice(-missRateWindowTurns * 3);
        }
      }

      stateBySession.set(ctx.sessionId, state);
      return result;
    },
  };
}
