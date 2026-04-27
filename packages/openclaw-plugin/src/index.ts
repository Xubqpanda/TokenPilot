/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  resolveReductionPasses as resolveLayerReductionPasses,
  runReductionBeforeCall as runLayerReductionBeforeCall,
  runReductionAfterCall as runLayerReductionAfterCall,
} from "./execution/reduction/pipeline.js";
import { createPolicyModule } from "../../layers/decision/src/policy.js";
import {
  applyProxyReductionToInput,
  applyLayeredReductionAfterCall,
  applyLayeredReductionAfterCallToSse,
  buildLayeredReductionContext,
  estimatePayloadInputChars,
  extractInputText,
  findDeveloperAndPrimaryUser,
  isReductionPassEnabled,
  isSseContentType,
  loadOrderedTurnAnchors,
  loadSegmentAnchorByCallId,
  normalizeText,
  normalizeTurnBindingMessage,
  prependTextToContent,
  rewritePayloadForStablePrefix,
  rewriteRootPromptForStablePrefix,
  type ProxyAfterCallReductionResult,
  type ProxyReductionResult,
  type RootPromptRewrite,
} from "./context-stack/request-preprocessing.js";
import {
  extractTurnObservations,
  inferObservationPayloadKind,
  readTranscriptEntriesForSession,
  syncRawSemanticTurnsFromTranscript,
  transcriptMessageStableId,
} from "./context-stack/page-out.js";
import {
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  archiveContent,
  buildRecoveryHint,
  injectMemoryFaultProtocolInstructions,
  registerMemoryFaultRecoverTool,
  stripInternalPayloadMarkers,
} from "./context-stack/page-in.js";
import {
  PluginRuntimeConfig,
  PluginLogger,
  applyBeforeToolCallDefaults,
  applyPolicyBeforeCall,
  asRecord,
  buildPolicyModuleConfigFromPluginConfig,
  canonicalMessageTaskIds,
  contentToText,
  detectUpstreamConfig,
  dedupeStrings,
  ensureContextSafeDetails,
  extractPathLike,
  extractItemText,
  extractLastUserMessage,
  extractOpenClawSessionId,
  extractSessionKey,
  extractToolMessageText,
  findLastUserItem,
  hookOn,
  installLlmHookTap,
  isToolResultLikeMessage,
  makeLogger,
  messageToolCallId,
  maybeRegisterProxyProvider,
  normalizeConfig,
  ensureExplicitProxyModelsInConfig,
  requestUpstreamResponses,
  createPluginContextEngine,
  normalizeProxyModelId,
  registerRuntime,
  type UpstreamConfig,
  type UpstreamHttpResponse,
  safeId,
} from "./context-stack/integration.js";
import {
  appendJsonl,
  appendForwardedInputDump,
  appendReductionPassTrace,
  appendTaskStateTrace,
} from "./trace/io.js";
import { applyToolResultPersistPolicy } from "./context-stack/request-preprocessing/tool-results-persist.js";
import { contextSafeRecovery as importedContextSafeRecovery, hasRecoveryMarker as importedHasRecoveryMarker } from "./context-stack/page-in.js";


const proxyRuntimeHelpers = {
  detectUpstreamConfig,
  createPolicyModule,
  buildPolicyModuleConfigFromPluginConfig,
  normalizeProxyModelId,
  injectMemoryFaultProtocolInstructions,
  normalizeText,
  findDeveloperAndPrimaryUser,
  rewriteRootPromptForStablePrefix,
  prependTextToContent,
  rewritePayloadForStablePrefix,
  estimatePayloadInputChars,
  appendTaskStateTrace,
  applyProxyReductionToInput,
  applyPolicyBeforeCall,
  buildLayeredReductionContext,
  isReductionPassEnabled,
  loadOrderedTurnAnchors,
  loadSegmentAnchorByCallId,
  dedupeStrings,
  syncRawSemanticTurnsFromTranscript,
  contentToText,
  contextSafeRecovery,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  hasRecoveryMarker,
  inferObservationPayloadKind,
  makeLogger,
  stripInternalPayloadMarkers,
  extractInputText,
  appendReductionPassTrace,
  appendJsonl,
  appendForwardedInputDump,
  requestUpstreamResponses,
  applyLayeredReductionAfterCall,
  applyLayeredReductionAfterCallToSse,
  isSseContentType,
};

function contextSafeRecovery(details: unknown): Record<string, unknown> | undefined {
  return importedContextSafeRecovery(details, asRecord);
}

function hasRecoveryMarker(details: unknown): boolean {
  return importedHasRecoveryMarker(details, asRecord);
}

const __testHooks = {
  rewritePayloadForStablePrefix,
  applyProxyReductionToInput,
  stripInternalPayloadMarkers,
  normalizeConfig,
};

module.exports = {
  id: "ecoclaw",
  name: "TokenPilot Runtime Optimizer",
  __testHooks,

  register(api: any) {
    const logger = makeLogger(api?.logger);
    const cfg = normalizeConfig(api?.pluginConfig);

    if (!cfg.enabled) {
      logger.info("[plugin-runtime] Plugin disabled by config.");
      return;
    }

    if (cfg.hooks.beforeToolCall) {
      hookOn(api, "before_tool_call", (event: any) => {
        return { params: applyBeforeToolCallDefaults(event) };
      });
    }

    if (cfg.hooks.toolResultPersist) {
      hookOn(api, "tool_result_persist", (event: any) => {
        const out = applyToolResultPersistPolicy(event, cfg, logger, {
          appendTaskStateTrace,
          ensureContextSafeDetails,
          extractToolMessageText,
          isToolResultLikeMessage,
          safeId,
        });
        return out ?? { message: event?.message };
      });
    }

    if (cfg.contextEngine.enabled && typeof api.registerContextEngine === "function") {
      api.registerContextEngine("ecoclaw-context", () => createPluginContextEngine(cfg, logger, {
        appendTaskStateTrace,
        readTranscriptEntriesForSession,
        transcriptMessageStableId,
        asRecord,
        canonicalMessageTaskIds,
        contentToText,
        dedupeStrings,
        ensureContextSafeDetails,
        extractPathLike,
        extractToolMessageText,
        isToolResultLikeMessage,
        messageToolCallId,
        safeId,
      }));
    } else if (cfg.contextEngine.enabled) {
      logger.warn("[plugin-runtime] registerContextEngine unavailable in this OpenClaw version.");
    }

    void registerRuntime(api, cfg, logger, {
      debugEnabled: cfg.logLevel === "debug",
      hookOn,
      safeId,
      contentToText,
      contextSafeRecovery,
      memoryFaultRecoverToolName: MEMORY_FAULT_RECOVER_TOOL_NAME,
      extractTurnObservations,
      extractSessionKey,
      extractLastUserMessage,
      extractOpenClawSessionId,
      normalizeTurnBindingMessage,
      extractItemText: (item: any) => extractItemText(item, extractInputText),
      findLastUserItem,
      syncRawSemanticTurnsFromTranscript,
      appendTaskStateTrace,
      maybeRegisterProxyProvider,
      ensureExplicitProxyModelsInConfig,
      installLlmHookTap,
      proxyRuntimeHelpers,
    });
  },
};
