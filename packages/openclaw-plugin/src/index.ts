/* eslint-disable @typescript-eslint/no-explicit-any */
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpenClawConnector } from "@ecoclaw/connector-openclaw";
import { createCacheModule } from "@ecoclaw/module-cache";
import { createPolicyModule } from "@ecoclaw/module-policy";
import { createSummaryModule } from "@ecoclaw/module-summary";
import { createMemoryStateModule } from "@ecoclaw/module-memory-state";
import { createCompressionModule } from "@ecoclaw/module-compression";
import { openaiAdapter } from "@ecoclaw/provider-openai";
import { anthropicAdapter } from "@ecoclaw/provider-anthropic";
import type { RuntimeTurnContext } from "@ecoclaw/kernel";

type EcoClawPluginConfig = {
  enabled?: boolean;
  logLevel?: "info" | "debug";
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  runtimeMode?: "off" | "shadow";
  stateDir?: string;
  eventTracePath?: string;
  autoForkOnPolicy?: boolean;
  cacheTtlSeconds?: number;
  summaryTriggerInputTokens?: number;
  summaryTriggerStableChars?: number;
  summaryRecentTurns?: number;
  maxSummaryChars?: number;
  compactionPrompt?: string;
  resumePrefixPrompt?: string;
};

type PluginLogger = {
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

function normalizeConfig(raw: unknown): Required<Omit<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey">> &
  Pick<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey"> {
  const cfg = (raw ?? {}) as EcoClawPluginConfig;
  const defaultStateDir = join(homedir(), ".openclaw", "ecoclaw-plugin-state");
  const stateDir = cfg.stateDir ?? defaultStateDir;
  return {
    enabled: cfg.enabled ?? true,
    logLevel: cfg.logLevel ?? "info",
    proxyBaseUrl: cfg.proxyBaseUrl,
    proxyApiKey: cfg.proxyApiKey,
    runtimeMode: cfg.runtimeMode ?? "shadow",
    stateDir,
    eventTracePath: cfg.eventTracePath ?? join(stateDir, "ecoclaw", "event-trace.jsonl"),
    autoForkOnPolicy: cfg.autoForkOnPolicy ?? true,
    cacheTtlSeconds: Math.max(60, cfg.cacheTtlSeconds ?? 600),
    summaryTriggerInputTokens: Math.max(0, cfg.summaryTriggerInputTokens ?? 20000),
    summaryTriggerStableChars: Math.max(0, cfg.summaryTriggerStableChars ?? 0),
    summaryRecentTurns: Math.max(1, cfg.summaryRecentTurns ?? 8),
    maxSummaryChars: Math.max(200, cfg.maxSummaryChars ?? 6000),
    compactionPrompt: cfg.compactionPrompt,
    resumePrefixPrompt: cfg.resumePrefixPrompt,
  };
}

function makeLogger(input?: PluginLogger): Required<PluginLogger> {
  return {
    info: input?.info ?? ((...args) => console.log(...args)),
    debug: input?.debug ?? (() => {}),
    warn: input?.warn ?? ((...args) => console.warn(...args)),
    error: input?.error ?? ((...args) => console.error(...args)),
  };
}

function hookOn(api: any, event: string, handler: (...args: any[]) => any): void {
  if (typeof api.on === "function") {
    api.on(event, handler);
    return;
  }
  if (typeof api.registerHook === "function") {
    api.registerHook(event, handler);
  }
}

function maybeRegisterProxyProvider(api: any, cfg: ReturnType<typeof normalizeConfig>, logger: Required<PluginLogger>) {
  if (!cfg.proxyBaseUrl) return;
  if (typeof api.registerProvider !== "function") {
    logger.warn("[ecoclaw] registerProvider not supported by this OpenClaw version.");
    return;
  }

  try {
    api.registerProvider({
      id: "ecoclaw",
      name: "EcoClaw Router",
      label: "EcoClaw Router",
      api: "openai-completions",
      baseUrl: cfg.proxyBaseUrl,
      apiKey: cfg.proxyApiKey,
      models: ["auto"],
    });
    logger.info("[ecoclaw] Registered provider ecoclaw/auto via proxyBaseUrl.");
  } catch (err: unknown) {
    logger.error(`[ecoclaw] Failed to register provider: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function extractSessionKey(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  return (
    event?.sessionKey ??
    event?.session?.key ??
    event?.sessionId ??
    event?.result?.sessionId ??
    agentMeta?.sessionId ??
    "unknown"
  );
}

function extractLastUserMessage(event: any): string {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
  return String(lastUser?.content ?? event?.message?.content ?? event?.message ?? "");
}

function extractLastAssistant(event: any): any {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const fromMessages = [...messages].reverse().find((m: any) => m?.role === "assistant");
  if (fromMessages) return fromMessages;

  const payloads = Array.isArray(event?.result?.payloads) ? event.result.payloads : [];
  const lastPayload = payloads.length > 0 ? payloads[payloads.length - 1] : null;
  if (!lastPayload) return null;

  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta ?? {};
  const usage = agentMeta?.lastCallUsage ?? agentMeta?.usage ?? event?.usage ?? {};
  return {
    role: "assistant",
    content: String(lastPayload?.text ?? ""),
    provider: agentMeta?.provider ?? event?.provider,
    model: agentMeta?.model ?? event?.model,
    usage,
  };
}

function buildProviderRawFromAssistant(assistant: any): Record<string, unknown> {
  const usage = (assistant?.usage ?? {}) as Record<string, unknown>;
  const input = Number(
    usage.input_tokens ?? usage.input ?? usage.prompt_tokens ?? usage.promptTokens ?? 0,
  );
  const output = Number(
    usage.output_tokens ?? usage.output ?? usage.completion_tokens ?? usage.completionTokens ?? 0,
  );
  const cacheRead = Number(
    usage.cacheRead ??
      usage.cache_read_tokens ??
      usage.cache_read_input_tokens ??
      (usage.prompt_tokens_details as any)?.cached_tokens ??
      0,
  );
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    prompt_tokens_details: {
      cached_tokens: Number.isFinite(cacheRead) ? cacheRead : 0,
    },
  };
}

module.exports = {
  id: "ecoclaw",
  name: "EcoClaw Runtime Optimizer",

  register(api: any) {
    const logger = makeLogger(api?.logger);
    const cfg = normalizeConfig(api?.pluginConfig);
    const debugEnabled = cfg.logLevel === "debug";

    if (!cfg.enabled) {
      logger.info("[ecoclaw] Plugin disabled by config.");
      return;
    }

    maybeRegisterProxyProvider(api, cfg, logger);
    const shadowConnector =
      cfg.runtimeMode === "shadow"
        ? createOpenClawConnector({
            modules: [
              createCacheModule({ minPrefixChars: 32, tree: { ttlSeconds: cfg.cacheTtlSeconds } }),
              createPolicyModule({
                summaryTriggerInputTokens: cfg.summaryTriggerInputTokens,
                summaryTriggerStableChars: cfg.summaryTriggerStableChars,
              }),
              createMemoryStateModule({ maxSummaryChars: cfg.maxSummaryChars }),
              createSummaryModule({
                idleTriggerMinutes: 50,
                recentTurns: cfg.summaryRecentTurns,
                compactionPrompt: cfg.compactionPrompt,
                resumePrefixPrompt: cfg.resumePrefixPrompt,
              }),
              createCompressionModule({ maxToolChars: 1200 }),
            ],
            adapters: {
              openai: openaiAdapter,
              anthropic: anthropicAdapter,
            },
            stateDir: cfg.stateDir,
            routing: {
              autoForkOnPolicy: cfg.autoForkOnPolicy,
              physicalSessionPrefix: "phy",
            },
            observability: {
              eventTracePath: cfg.eventTracePath,
            },
          })
        : null;

    hookOn(api, "message_received", (event: any) => {
      if (!debugEnabled) return;
      const sessionKey = extractSessionKey(event);
      logger.debug(`[ecoclaw] message_received session=${sessionKey}`);
    });

    hookOn(api, "agent_end", async (event: any) => {
      const sessionKey = extractSessionKey(event);
      const lastAssistant = extractLastAssistant(event);
      const model = lastAssistant?.model ?? event?.model ?? "unknown";
      const provider = lastAssistant?.provider ?? event?.provider ?? "unknown";
      if (debugEnabled) {
        logger.debug(`[ecoclaw] agent_end session=${sessionKey} provider=${provider} model=${model}`);
      }
      if (!shadowConnector) return;
      const logicalSessionId = `oc-${sessionKey}`;
      const userMessage = extractLastUserMessage(event) || "[empty-user-message]";
      const assistantContent = String(lastAssistant?.content ?? "");
      const providerId = String(provider || "openai").toLowerCase();
      const runtimeProvider = providerId.includes("anthropic") ? "anthropic" : "openai";
      const runtimeModel = String(model || (runtimeProvider === "anthropic" ? "claude-sonnet-4" : "gpt-5"));

      const turnCtx: RuntimeTurnContext = {
        sessionId: logicalSessionId,
        sessionMode: "cross",
        provider: runtimeProvider,
        model: runtimeModel,
        prompt: userMessage,
        segments: [
          {
            id: "stable-system",
            kind: "stable",
            text: "SYSTEM_STABLE: Keep assistant behavior consistent and compact.",
            priority: 1,
          },
          {
            id: "volatile-user",
            kind: "volatile",
            text: userMessage,
            priority: 10,
          },
        ],
        budget: {
          maxInputTokens: 12000,
          reserveOutputTokens: 1200,
        },
        metadata: {
          logicalSessionId,
          source: "openclaw-plugin-shadow",
        },
      };

      try {
        const shadowResult = await shadowConnector.onLlmCall(turnCtx, async () => ({
          content: assistantContent,
          usage: {
            providerRaw: buildProviderRawFromAssistant(lastAssistant),
          },
        }));
        const physical = shadowConnector.getPhysicalSessionId(logicalSessionId);
        const eventTypes =
          ((shadowResult.metadata as Record<string, any>)?.ecoclawEvents as Array<{ type: string }> | undefined)
            ?.map((e) => e.type)
            .join(",") ?? "";
        logger.debug(
          `[ecoclaw] shadow_runtime logical=${logicalSessionId} physical=${physical ?? "n/a"} events=${eventTypes}`,
        );
      } catch (err: unknown) {
        logger.warn(
          `[ecoclaw] shadow runtime failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    if (typeof api.registerService === "function") {
      api.registerService({
        id: "ecoclaw-runtime",
        start: () => {
          logger.info("[ecoclaw] Plugin active.");
          if (cfg.proxyBaseUrl) {
            logger.info(`[ecoclaw] Proxy mode baseUrl=${cfg.proxyBaseUrl}`);
          } else {
            logger.info("[ecoclaw] Running in hook-only mode (no proxy provider configured).");
          }
          logger.info(
            `[ecoclaw] Runtime mode=${cfg.runtimeMode} stateDir=${cfg.stateDir} autoFork=${cfg.autoForkOnPolicy} cacheTtl=${cfg.cacheTtlSeconds}s summaryTriggerInputTokens=${cfg.summaryTriggerInputTokens}`,
          );
          if (cfg.eventTracePath) {
            logger.info(`[ecoclaw] Event trace path=${cfg.eventTracePath}`);
          }
        },
        stop: () => {
          logger.info("[ecoclaw] Plugin stopped.");
        },
      });
    }
  },
};
