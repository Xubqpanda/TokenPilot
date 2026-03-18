/* eslint-disable @typescript-eslint/no-explicit-any */

type EcoClawPluginConfig = {
  enabled?: boolean;
  logLevel?: "info" | "debug";
  proxyBaseUrl?: string;
  proxyApiKey?: string;
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
  return {
    enabled: cfg.enabled ?? true,
    logLevel: cfg.logLevel ?? "info",
    proxyBaseUrl: cfg.proxyBaseUrl,
    proxyApiKey: cfg.proxyApiKey,
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

    hookOn(api, "message_received", (event: any) => {
      if (!debugEnabled) return;
      const sessionKey = event?.sessionKey ?? event?.session?.key ?? "unknown";
      logger.debug(`[ecoclaw] message_received session=${sessionKey}`);
    });

    hookOn(api, "agent_end", (event: any) => {
      if (!debugEnabled) return;
      const sessionKey = event?.sessionKey ?? event?.session?.key ?? "unknown";
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
      const model = lastAssistant?.model ?? event?.model ?? "unknown";
      const provider = lastAssistant?.provider ?? event?.provider ?? "unknown";
      logger.debug(`[ecoclaw] agent_end session=${sessionKey} provider=${provider} model=${model}`);
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
        },
        stop: () => {
          logger.info("[ecoclaw] Plugin stopped.");
        },
      });
    }
  },
};
