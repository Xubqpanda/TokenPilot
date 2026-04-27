/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  listRawSemanticTurnSeqs,
  loadRawSemanticTurnRecord,
} from "../../../../layers/history/src/raw-semantic.js";
import { loadSessionTaskRegistry } from "../../../../layers/history/src/registry.js";

export async function loadSegmentAnchorByCallId(
  stateDir: string,
  sessionId: string,
  helpers: {
    dedupeStrings: (values: string[]) => string[];
    syncRawSemanticTurnsFromTranscript: (stateDir: string, sessionId: string) => Promise<void>;
  },
): Promise<Map<string, { turnAbsIds: string[]; taskIds: string[] }>> {
  const registry = await loadSessionTaskRegistry(stateDir, sessionId);
  await helpers.syncRawSemanticTurnsFromTranscript(stateDir, sessionId);
  const turnSeqs = await listRawSemanticTurnSeqs(stateDir, sessionId);
  const out = new Map<string, { turnAbsIds: string[]; taskIds: string[] }>();

  const put = (callId: string, turnAbsId: string, taskIds: string[]): void => {
    const normalizedCallId = String(callId ?? "").trim();
    const normalizedTurnAbsId = String(turnAbsId ?? "").trim();
    if (!normalizedCallId || !normalizedTurnAbsId) return;
    const prev = out.get(normalizedCallId);
    if (!prev) {
      out.set(normalizedCallId, {
        turnAbsIds: [normalizedTurnAbsId],
        taskIds: helpers.dedupeStrings(taskIds),
      });
      return;
    }
    prev.turnAbsIds = helpers.dedupeStrings([...prev.turnAbsIds, normalizedTurnAbsId]);
    prev.taskIds = helpers.dedupeStrings([...prev.taskIds, ...taskIds]);
  };

  for (const turnSeq of turnSeqs) {
    const rawTurn = await loadRawSemanticTurnRecord(stateDir, sessionId, turnSeq);
    if (!rawTurn) continue;
    const turnAbsId = rawTurn.turnAbsId;
    const taskIds = registry.turnToTaskIds[turnAbsId] ?? [];
    for (const toolCall of rawTurn.toolCalls) {
      put(toolCall.toolCallId, turnAbsId, taskIds);
    }
    for (const toolResult of rawTurn.toolResults) {
      put(toolResult.toolCallId, turnAbsId, taskIds);
    }
  }

  return out;
}

export async function loadOrderedTurnAnchors(
  stateDir: string,
  sessionId: string,
  dedupeStrings: (values: string[]) => string[],
): Promise<Array<{ turnAbsId: string; taskIds: string[] }>> {
  const registry = await loadSessionTaskRegistry(stateDir, sessionId);
  return Object.entries(registry.turnToTaskIds)
    .map(([turnAbsId, taskIds]) => ({
      turnAbsId,
      taskIds: dedupeStrings(taskIds),
      turnSeq: Number(turnAbsId.split(":t").at(-1) ?? Number.NaN),
    }))
    .filter((item) => item.turnAbsId.trim().length > 0 && Number.isFinite(item.turnSeq))
    .sort((a, b) => a.turnSeq - b.turnSeq)
    .map(({ turnAbsId, taskIds }) => ({ turnAbsId, taskIds }));
}

export function isReductionPassEnabled(
  passId: string,
  passToggles?: {
    repeatedReadDedup?: boolean;
    toolPayloadTrim?: boolean;
    htmlSlimming?: boolean;
    execOutputTruncation?: boolean;
    agentsStartupOptimization?: boolean;
  },
): boolean {
  if (!passToggles) return true;
  switch (passId) {
    case "repeated_read_dedup":
      return passToggles.repeatedReadDedup ?? true;
    case "tool_payload_trim":
      return passToggles.toolPayloadTrim ?? true;
    case "html_slimming":
      return passToggles.htmlSlimming ?? true;
    case "exec_output_truncation":
      return passToggles.execOutputTruncation ?? true;
    case "agents_startup_optimization":
      return passToggles.agentsStartupOptimization ?? true;
    default:
      return true;
  }
}
