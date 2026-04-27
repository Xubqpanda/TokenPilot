/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadSessionTaskRegistry } from "../../../../layers/history/src/registry.js";
import { annotateCanonicalMessagesWithTaskAnchors } from "./canonical-anchors.js";
import {
  appendCanonicalTranscript,
  estimateMessagesChars,
  loadCanonicalState,
  type EcoCanonicalState,
} from "./canonical-state.js";
import { applyCanonicalEviction } from "../../canonical/eviction.js";

type SyncHelpers<TEntry> = {
  appendTaskStateTrace: (stateDir: string, payload: Record<string, unknown>) => Promise<void>;
  readTranscriptEntriesForSession: (sessionId: string) => Promise<TEntry[] | null>;
  stableIdForEntry: (entry: TEntry) => string;
};

export async function syncCanonicalStateFromTranscript<TEntry>(params: {
  stateDir: string;
  sessionId: string;
  getMessage: (entry: TEntry) => any;
  helpers: SyncHelpers<TEntry>;
}): Promise<{ state: EcoCanonicalState; changed: boolean }> {
  const loaded = await loadCanonicalState(params.stateDir, params.sessionId);
  const transcriptEntries = await params.helpers.readTranscriptEntriesForSession(params.sessionId);
  if (!transcriptEntries) {
    if (loaded) return { state: loaded, changed: false };
    const emptyState: EcoCanonicalState = {
      version: 1,
      sessionId: params.sessionId,
      messages: [],
      seenMessageIds: [],
      updatedAt: new Date().toISOString(),
    };
    return { state: emptyState, changed: false };
  }
  const appended = appendCanonicalTranscript(
    loaded,
    transcriptEntries,
    params.sessionId,
    params.getMessage,
    params.helpers.stableIdForEntry,
  );
  await params.helpers.appendTaskStateTrace(params.stateDir, {
    stage: "canonical_state_sync",
    sessionId: params.sessionId,
    changed: appended.changed,
    loadedMessageCount: Array.isArray(loaded?.messages) ? loaded.messages.length : 0,
    transcriptEntryCount: transcriptEntries.length,
    finalMessageCount: appended.state.messages.length,
    appendedMessageCount: Math.max(
      0,
      appended.state.messages.length - (Array.isArray(loaded?.messages) ? loaded.messages.length : 0),
    ),
    seenMessageIdsCount: Array.isArray(appended.state.seenMessageIds) ? appended.state.seenMessageIds.length : 0,
  });
  return appended;
}

type RewriteHelpers = {
  appendTaskStateTrace: (stateDir: string, payload: Record<string, unknown>) => Promise<void>;
  asRecord: (value: unknown) => Record<string, unknown> | undefined;
  canonicalMessageTaskIds: (message: Record<string, unknown>) => string[];
  contentToText: (value: unknown) => string;
  dedupeStrings: (values: string[]) => string[];
  ensureContextSafeDetails: (
    details: unknown,
    patch: Record<string, unknown>,
  ) => Record<string, unknown>;
  extractPathLike: (value: unknown) => string | undefined;
  extractToolMessageText: (message: Record<string, unknown>) => string;
  isToolResultLikeMessage: (message: Record<string, unknown>) => boolean;
  logger?: { info: (message: string) => void };
  messageToolCallId: (message: Record<string, unknown>) => string | undefined;
  safeId: (value: string) => string;
};

export async function rewriteCanonicalState(params: {
  stateDir: string;
  sessionId: string;
  state: EcoCanonicalState;
  evictionEnabled?: boolean;
  evictionPolicy?: string;
  evictionMinBlockChars?: number;
  evictionReplacementMode?: "pointer_stub" | "drop";
  helpers: RewriteHelpers;
}): Promise<{ state: EcoCanonicalState; changed: boolean }> {
  const registry = await loadSessionTaskRegistry(params.stateDir, params.sessionId);
  const startMessages = params.state.messages;
  let messages = startMessages;
  let changed = false;
  const annotated = annotateCanonicalMessagesWithTaskAnchors(
    messages,
    registry,
    params.helpers.asRecord,
    params.helpers.dedupeStrings,
    params.helpers.ensureContextSafeDetails,
  );
  if (annotated.changed) {
    messages = annotated.messages;
    changed = true;
  }
  const replacementMode = params.evictionReplacementMode === "drop" ? "drop" : "pointer_stub";
  const evictionApplied = await applyCanonicalEviction({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
    messages,
    registry,
    enabled: params.evictionEnabled === true,
    policy: params.evictionPolicy ?? "noop",
    minBlockChars: Math.max(0, params.evictionMinBlockChars ?? 256),
    replacementMode,
    helpers: {
      asRecord: params.helpers.asRecord,
      appendTaskStateTrace: params.helpers.appendTaskStateTrace,
      canonicalMessageTaskIds: params.helpers.canonicalMessageTaskIds,
      contentToText: params.helpers.contentToText,
      dedupeStrings: params.helpers.dedupeStrings,
      ensureContextSafeDetails: params.helpers.ensureContextSafeDetails,
      extractPathLike: params.helpers.extractPathLike,
      extractToolMessageText: params.helpers.extractToolMessageText,
      isToolResultLikeMessage: params.helpers.isToolResultLikeMessage,
      messageToolCallId: params.helpers.messageToolCallId,
      safeId: params.helpers.safeId,
    },
  });
  if (evictionApplied.changed) {
    messages = evictionApplied.messages;
    changed = true;
    await params.helpers.appendTaskStateTrace(params.stateDir, {
      stage: "canonical_eviction_applied",
      sessionId: params.sessionId,
      appliedCount: evictionApplied.appliedCount,
      appliedTaskIds: evictionApplied.appliedTaskIds,
      evictableTaskIds: registry.evictableTaskIds,
      replacementMode,
    });
    params.helpers.logger?.info(
      `[ecoclaw/eviction-apply] session=${params.sessionId} applied=${evictionApplied.appliedCount} tasks=${evictionApplied.appliedTaskIds.join(", ") || "none"}`,
    );
  }
  await params.helpers.appendTaskStateTrace(params.stateDir, {
    stage: "canonical_state_rewrite",
    sessionId: params.sessionId,
    changed,
    replacementMode,
    beforeMessageCount: startMessages.length,
    afterAnnotationMessageCount: annotated.changed ? annotated.messages.length : startMessages.length,
    afterEvictionMessageCount: messages.length,
    beforeChars: estimateMessagesChars(startMessages, params.helpers.contentToText),
    afterChars: estimateMessagesChars(messages, params.helpers.contentToText),
    evictableTaskIds: registry.evictableTaskIds,
  });
  return {
    state: changed
      ? {
          ...params.state,
          messages,
          updatedAt: new Date().toISOString(),
        }
      : params.state,
    changed,
  };
}
