import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeModule,
} from "@ecoclaw/kernel";

type ContextStateEntry = {
  materializedText: string;
  summaryText: string;
  recentMessages?: Array<{
    index?: number;
    at?: string;
    user?: string;
    assistant?: string;
  }>;
  updatedAt: string;
  source: string;
};

export type ContextStateModuleConfig = {
  maxSummaryChars?: number;
};

export function createContextStateModule(cfg: ContextStateModuleConfig = {}): RuntimeModule {
  const maxSummaryChars = Math.max(200, cfg.maxSummaryChars ?? 2000);
  const stateBySession = new Map<string, ContextStateEntry>();

  return {
    name: "module-context-state",
    async beforeBuild(ctx) {
      const state = stateBySession.get(ctx.sessionId);
      if (!state) return ctx;
      const nextCtx = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          contextState: {
            available: true,
            updatedAt: state.updatedAt,
            source: state.source,
          },
        },
      };
      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.CONTEXT_STATE_AVAILABLE,
        source: "module-context-state",
        at: new Date().toISOString(),
        payload: {
          updatedAt: state.updatedAt,
          source: state.source,
          contextPreview: state.materializedText.slice(0, 200),
          recentMessageCount: state.recentMessages?.length ?? 0,
        },
      });
    },
    async afterCall(ctx, result) {
      const events = findRuntimeEventsByType(
        result.metadata,
        ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED,
      );
      if (events.length === 0) return result;
      const latest = events[events.length - 1];
      const payload = latest.payload as Record<string, unknown> | undefined;
      const artifact = (payload?.artifact ?? {}) as Record<string, unknown>;
      const rawSummary = String(artifact.summaryText ?? "");
      const summaryText = rawSummary.length > maxSummaryChars
        ? `${rawSummary.slice(0, maxSummaryChars)}\n...[truncated]`
        : rawSummary;
      const recentMessages = Array.isArray(artifact.recentMessages)
        ? (artifact.recentMessages as Array<{
            index?: number;
            at?: string;
            user?: string;
            assistant?: string;
          }>)
        : [];
      const materializedText = summaryText;
      const updatedAt = new Date().toISOString();
      stateBySession.set(ctx.sessionId, {
        materializedText,
        summaryText,
        recentMessages,
        updatedAt,
        source: "module-summary",
      });
      return appendResultEvent(
        {
          ...result,
          metadata: {
            ...(result.metadata ?? {}),
            contextState: {
              available: true,
              updatedAt,
              source: "module-summary",
            },
          },
        },
        {
          type: ECOCLAW_EVENT_TYPES.CONTEXT_STATE_UPDATED,
          source: "module-context-state",
          at: updatedAt,
          payload: {
            updatedAt,
            source: "module-summary",
            summaryChars: summaryText.length,
            materializedChars: materializedText.length,
            recentMessageCount: recentMessages.length,
          },
        },
      );
    },
  };
}
