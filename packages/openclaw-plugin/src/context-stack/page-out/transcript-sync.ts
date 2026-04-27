/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  buildTurnAbsId,
  createTurnAnchor,
  loadRawSemanticTurnRecord,
  persistRawSemanticTurnRecord,
} from "../../../../layers/history/src/raw-semantic.js";
import type { RawSemanticTurnRecord } from "../../../../layers/history/src/types.js";

export type TranscriptSessionRow = {
  id?: string;
  parentId?: string;
  timestamp?: string;
  message: Record<string, unknown>;
};

export type StructuredTurnObservation = {
  id: string;
  role: "tool" | "observation";
  text: string;
  payloadKind?: "stdout" | "stderr" | "json" | "blob";
  toolName?: string;
  source: string;
  messageIndex?: number;
  mimeType?: string;
  textChars: number;
  textPreview: string;
  metadata?: Record<string, unknown>;
  recovery?: {
    source: string;
    skipReduction?: boolean;
  };
};

type TranscriptHelpers = {
  contentToText: (value: unknown) => string;
  contextSafeRecovery: (details: unknown) => Record<string, unknown> | undefined;
  memoryFaultRecoverToolName: string;
};

export function inferObservationPayloadKind(
  text: string,
  fallback?: unknown,
): StructuredTurnObservation["payloadKind"] | undefined {
  if (typeof fallback === "string") {
    const normalized = fallback.trim().toLowerCase();
    if (
      normalized === "stdout" ||
      normalized === "stderr" ||
      normalized === "json" ||
      normalized === "blob"
    ) {
      return normalized;
    }
  }

  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/^stderr\s*[:=-]/i.test(trimmed)) return "stderr";
  if (/^stdout\s*[:=-]/i.test(trimmed)) return "stdout";
  if (/^blob\s*[:=-]/i.test(trimmed)) return "blob";
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // fall through
  }
  if (/^data:[^;]+;base64,/i.test(trimmed)) return "blob";
  if (/^[A-Za-z0-9+/=\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return "blob";
  return undefined;
}

function buildToolCallArgsMap(messages: any[]): Map<string, { toolName?: string; path?: string }> {
  const map = new Map<string, { toolName?: string; path?: string }>();
  for (const msg of messages) {
    const role = String(msg?.role ?? "").toLowerCase();
    if (role !== "assistant") continue;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "toolCall" && item.type !== "tool_call") continue;
      const callId =
        typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : undefined;
      if (!callId) continue;
      const toolName =
        typeof item.name === "string" && item.name.trim().length > 0
          ? item.name.trim()
          : undefined;
      const args =
        item.arguments && typeof item.arguments === "object"
          ? (item.arguments as Record<string, unknown>)
          : undefined;
      const path =
        typeof args?.path === "string" && args.path.trim().length > 0
          ? args.path.trim()
          : typeof args?.file_path === "string" && args.file_path.trim().length > 0
            ? args.file_path.trim()
            : typeof args?.filePath === "string" && args.filePath.trim().length > 0
              ? args.filePath.trim()
              : undefined;
      map.set(callId, { toolName, path });
    }
  }
  return map;
}

function isWriteLikeToolName(toolName: string | undefined): boolean {
  const normalized = String(toolName ?? "").trim().toLowerCase();
  return normalized === "write" || normalized.endsWith(".write") || normalized.includes("write_file");
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function summarizeText(text: string, maxChars = 800): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function extractAssistantText(content: unknown, helpers: TranscriptHelpers): string {
  if (!Array.isArray(content)) return helpers.contentToText(content).trim();
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      const text = helpers.contentToText(item).trim();
      if (text) parts.push(text);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    if (type === "toolcall" || type === "tool_call") continue;
    const text = helpers.contentToText(obj).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

function extractFileRefsFromToolArgs(args: Record<string, unknown> | undefined): {
  filesRead: string[];
  filesWritten: string[];
} {
  const candidates = [
    args?.path,
    args?.file_path,
    args?.filePath,
    args?.output,
    args?.output_path,
    args?.outputPath,
  ];
  const normalized = candidates
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const filesRead = dedupeStrings(normalized.filter((_, index) => index < 1));
  const filesWritten = dedupeStrings(normalized.filter((_, index) => index >= 1));
  return { filesRead, filesWritten };
}

function sliceMessagesForCurrentUserTurn(messages: any[]): any[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = String(messages[i]?.role ?? "").toLowerCase();
    if (role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  return lastUserIndex >= 0 ? messages.slice(lastUserIndex) : messages;
}

function sliceMessagesForTurnSeq(messages: any[], turnSeq: number): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const role = String(messages[i]?.role ?? "").toLowerCase();
    if (role === "user") userIndices.push(i);
  }
  if (userIndices.length === 0) return [];
  const turnIndex = Math.max(0, turnSeq - 1);
  if (turnIndex >= userIndices.length) return [];
  const start = userIndices[turnIndex]!;
  const endExclusive = turnIndex + 1 < userIndices.length ? userIndices[turnIndex + 1]! : messages.length;
  return messages.slice(start, endExclusive);
}

export function extractTurnObservations(event: any, helpers: TranscriptHelpers): StructuredTurnObservation[] {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const toolCallArgsMap = buildToolCallArgsMap(messages);
  const out: StructuredTurnObservation[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const role = String(msg?.role ?? "").toLowerCase();
    if (role !== "tool" && role !== "observation" && role !== "toolresult") continue;
    const text = helpers.contentToText(msg?.content ?? msg?.text ?? "").trim();
    if (!text) continue;
    const payloadKind = inferObservationPayloadKind(
      text,
      msg?.payloadKind ?? msg?.kind ?? msg?.type,
    );
    const toolName =
      typeof msg?.name === "string" && msg.name.trim().length > 0
        ? msg.name.trim()
        : typeof msg?.toolName === "string" && msg.toolName.trim().length > 0
          ? msg.toolName.trim()
          : typeof msg?.tool_name === "string" && msg.tool_name.trim().length > 0
            ? msg.tool_name.trim()
            : undefined;
    const callId =
      typeof msg?.tool_call_id === "string" && msg.tool_call_id.trim().length > 0
        ? msg.tool_call_id.trim()
        : typeof msg?.toolCallId === "string" && msg.toolCallId.trim().length > 0
          ? msg.toolCallId.trim()
          : undefined;
    const toolCallArgs = callId ? toolCallArgsMap.get(callId) : undefined;
    const resolvedPath = toolCallArgs?.path;
    const recovery = helpers.contextSafeRecovery(msg?.details);
    const metadata: Record<string, unknown> | undefined = resolvedPath
      ? { path: resolvedPath, file_path: resolvedPath }
      : undefined;
    out.push({
      id: callId ?? `msg-${i + 1}`,
      role: role === "tool" || role === "toolresult" ? "tool" : "observation",
      text,
      payloadKind,
      toolName: toolName ?? toolCallArgs?.toolName,
      source: "event.messages",
      messageIndex: i,
      mimeType:
        typeof msg?.mime_type === "string" && msg.mime_type.trim().length > 0
          ? msg.mime_type.trim()
          : typeof msg?.mimeType === "string" && msg.mimeType.trim().length > 0
            ? msg.mimeType.trim()
            : undefined,
      textChars: text.length,
      textPreview: text.length > 240 ? `${text.slice(0, 240)}...` : text,
      ...(metadata ? { metadata } : {}),
      ...(recovery
        ? {
            recovery: {
              source:
                typeof recovery.source === "string" && recovery.source.trim().length > 0
                  ? recovery.source.trim()
                  : helpers.memoryFaultRecoverToolName,
              skipReduction: recovery.skipReduction === true,
            },
          }
        : {}),
    });
  }
  return out;
}

function buildRawSemanticTurnRecordFromMessages(
  sessionId: string,
  turnSeq: number,
  messages: any[],
  helpers: TranscriptHelpers,
): RawSemanticTurnRecord | null {
  const scopedMessages = sliceMessagesForCurrentUserTurn(messages);
  if (scopedMessages.length === 0) return null;

  const userAnchor = createTurnAnchor(sessionId, turnSeq, "user");
  const assistantAnchor = createTurnAnchor(sessionId, turnSeq, "assistant");
  const toolAnchor = createTurnAnchor(sessionId, turnSeq, "tool");
  const rawRecord: RawSemanticTurnRecord = {
    sessionId,
    turnSeq,
    turnAbsId: buildTurnAbsId(sessionId, turnSeq),
    messages: [],
    toolCalls: [],
    toolResults: [],
  };

  for (const msg of scopedMessages) {
    const role = String(msg?.role ?? "").toLowerCase();
    if (role === "user") {
      const text = helpers.contentToText(msg?.content ?? msg?.text ?? "").trim();
      if (!text) continue;
      rawRecord.messages.push({
        anchor: userAnchor,
        role: "user",
        text,
      });
      continue;
    }
    if (role === "assistant") {
      const assistantText = extractAssistantText(msg?.content ?? msg?.text ?? "", helpers).trim();
      if (assistantText) {
        rawRecord.messages.push({
          anchor: assistantAnchor,
          role: "assistant",
          text: assistantText,
        });
      }
      const content = Array.isArray(msg?.content) ? msg.content : [];
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const type = String(obj.type ?? "").toLowerCase();
        if (type !== "toolcall" && type !== "tool_call") continue;
        const toolCallId =
          typeof obj.id === "string" && obj.id.trim().length > 0 ? obj.id.trim() : "";
        const toolName =
          typeof obj.name === "string" && obj.name.trim().length > 0 ? obj.name.trim() : "unknown";
        const args =
          obj.arguments && typeof obj.arguments === "object"
            ? (obj.arguments as Record<string, unknown>)
            : undefined;
        const argumentsText = args ? JSON.stringify(args) : undefined;
        const refs = extractFileRefsFromToolArgs(args);
        rawRecord.toolCalls.push({
          anchor: assistantAnchor,
          toolCallId: toolCallId || `toolcall-${rawRecord.toolCalls.length + 1}`,
          toolName,
          argumentsText,
          argumentsSummary: summarizeText(argumentsText ?? toolName, 400),
          ...(refs.filesRead.length > 0 ? { filesRead: refs.filesRead } : {}),
          ...(refs.filesWritten.length > 0 ? { filesWritten: refs.filesWritten } : {}),
        });
      }
      continue;
    }
  }

  const observations = extractTurnObservations({ messages: scopedMessages }, helpers);
  for (const observation of observations) {
    const filePath =
      typeof observation.metadata?.path === "string" && observation.metadata.path.trim().length > 0
        ? observation.metadata.path.trim()
        : undefined;
    rawRecord.toolResults.push({
      anchor: toolAnchor,
      toolCallId: observation.id,
      toolName: observation.toolName ?? "unknown",
      status: observation.payloadKind === "stderr" ? "error" : "success",
      fullText: observation.text,
      summary: summarizeText(observation.text, 800),
      rawContentRef: filePath,
      ...(observation.recovery ? { recovery: observation.recovery } : {}),
      ...(filePath
        ? isWriteLikeToolName(observation.toolName)
          ? { filesWritten: [filePath] }
          : { filesRead: [filePath] }
        : {}),
    });
  }

  if (
    rawRecord.messages.length === 0 &&
    rawRecord.toolCalls.length === 0 &&
    rawRecord.toolResults.length === 0
  ) {
    return null;
  }

  return rawRecord;
}

function dedupeRawSemanticMessages(record: RawSemanticTurnRecord["messages"]): RawSemanticTurnRecord["messages"] {
  const seen = new Set<string>();
  const out: RawSemanticTurnRecord["messages"] = [];
  for (const item of record) {
    const key = `${item.anchor.turnAbsId}:${item.role}:${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeRawSemanticToolCalls(record: RawSemanticTurnRecord["toolCalls"]): RawSemanticTurnRecord["toolCalls"] {
  const seen = new Set<string>();
  const out: RawSemanticTurnRecord["toolCalls"] = [];
  for (const item of record) {
    const key = `${item.toolCallId}:${item.toolName}:${item.argumentsText ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeRawSemanticToolResults(record: RawSemanticTurnRecord["toolResults"]): RawSemanticTurnRecord["toolResults"] {
  const seen = new Set<string>();
  const out: RawSemanticTurnRecord["toolResults"] = [];
  for (const item of record) {
    const key = `${item.toolCallId}:${item.toolName}:${item.status}:${item.fullText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function resolveOpenClawStateRoot(): string {
  const explicit =
    String(process.env.OPENCLAW_STATE_DIR ?? "").trim()
    || String(process.env.OPENCLAW_HOME ?? "").trim();
  if (explicit) return explicit;
  return join(homedir(), ".openclaw");
}

async function findTranscriptPathForSession(sessionId: string): Promise<string | null> {
  const stateRoot = resolveOpenClawStateRoot();
  const agentsDir = join(stateRoot, "agents");
  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      const candidate = join(agentsDir, agentEntry.name, "sessions", `${sessionId}.jsonl`);
      try {
        await readFile(candidate, "utf8");
        return candidate;
      } catch {
        // keep scanning
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeTranscriptMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as Record<string, unknown>;
      const type = typeof block.type === "string" ? block.type : "block";
      if (typeof block.text === "string") return `${type}:${block.text.trim()}`;
      if ((type === "toolCall" || type === "tool_call") && typeof block.name === "string") {
        return `${type}:${block.name}:${JSON.stringify(block.arguments ?? {}, Object.keys(block.arguments ?? {}).sort())}`;
      }
      return JSON.stringify(block);
    })
    .filter((item) => item.length > 0)
    .join("\n")
    .trim();
}

export function transcriptMessageStableId(row: TranscriptSessionRow): string {
  const nativeId = typeof row.id === "string" ? row.id.trim() : "";
  if (nativeId) return nativeId;
  const message = row.message;
  const role = typeof message.role === "string" ? message.role.trim() : "";
  const toolCallId =
    typeof message.toolCallId === "string" ? message.toolCallId.trim()
    : typeof (message as any).tool_call_id === "string" ? String((message as any).tool_call_id).trim()
    : "";
  const toolName =
    typeof message.toolName === "string" ? message.toolName.trim()
    : typeof (message as any).tool_name === "string" ? String((message as any).tool_name).trim()
    : "";
  const timestamp =
    (typeof row.timestamp === "string" && row.timestamp.trim().length > 0 ? row.timestamp.trim() : "")
    || (typeof message.timestamp === "string" ? message.timestamp.trim() : "")
    || (typeof message.timestamp === "number" ? String(message.timestamp) : "");
  const basis = [
    role,
    toolCallId,
    toolName,
    timestamp,
    normalizeTranscriptMessageText(message),
  ].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 20);
}

function splitTranscriptCandidateRecords(raw: string): string[] {
  const records: string[] = [];
  let current = "";
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (line.startsWith('{"type":')) {
      if (current.trim()) records.push(current);
      current = line;
    } else if (current) {
      current += `\n${line}`;
    }
  }
  if (current.trim()) records.push(current);
  return records;
}

function salvageTranscriptMessageRow(candidate: string): TranscriptSessionRow | null {
  const text = String(candidate ?? "");
  if (!text.includes('"type":"message"')) return null;
  if (!text.includes('"role":"toolResult"')) return null;
  const id = text.match(/"id":"([^"\n]+)"/)?.[1];
  const parentId = text.match(/"parentId":"([^"\n]+)"/)?.[1];
  const timestamp = text.match(/"timestamp":"([^"\n]+)"/)?.[1];
  const toolCallId = text.match(/"toolCallId":"([^"\n]+)"/)?.[1];
  const toolName = text.match(/"toolName":"([^"\n]+)"/)?.[1] ?? 'tool';
  return {
    id,
    parentId,
    timestamp,
    message: {
      role: 'toolResult',
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      content: [{
        type: 'text',
        text: `[Unparseable toolResult omitted: ${toolName}]`,
      }],
      details: {
        contextSafe: {
          transcriptSalvaged: true,
          transcriptSalvageReason: 'unparseable_tool_result',
        },
      },
    },
  };
}

export async function readTranscriptEntriesForSession(sessionId: string): Promise<TranscriptSessionRow[] | null> {
  const transcriptPath = await findTranscriptPathForSession(sessionId);
  if (!transcriptPath) return null;
  let raw = "";
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const entries: TranscriptSessionRow[] = [];
  for (const candidate of splitTranscriptCandidateRecords(raw)) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (row.type !== "message") continue;
      const message = row.message;
      if (!message || typeof message !== "object") continue;
      entries.push({
        id: typeof row.id === "string" ? row.id : undefined,
        parentId: typeof row.parentId === "string" ? row.parentId : undefined,
        timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
        message: structuredClone(message as Record<string, unknown>),
      });
    } catch {
      const salvaged = salvageTranscriptMessageRow(trimmed);
      if (salvaged) entries.push(salvaged);
    }
  }
  return entries;
}

export async function readTranscriptMessagesForSession(sessionId: string): Promise<any[] | null> {
  const entries = await readTranscriptEntriesForSession(sessionId);
  if (!entries) return null;
  return entries.map((entry) => entry.message);
}

async function buildRawSemanticTurnRecordFromTranscript(
  sessionId: string,
  turnSeq: number,
  helpers: TranscriptHelpers,
): Promise<RawSemanticTurnRecord | null> {
  const messages = await readTranscriptMessagesForSession(sessionId);
  if (!messages || messages.length === 0) return null;
  const scopedMessages = sliceMessagesForTurnSeq(messages, turnSeq);
  if (scopedMessages.length === 0) return null;
  return buildRawSemanticTurnRecordFromMessages(sessionId, turnSeq, scopedMessages, helpers);
}

export async function syncRawSemanticTurnsFromTranscript(
  stateDir: string,
  sessionId: string,
  helpers: TranscriptHelpers,
): Promise<{ changed: boolean; turnCount: number; updatedTurnSeqs: number[] }> {
  const messages = await readTranscriptMessagesForSession(sessionId);
  if (!messages || messages.length === 0) {
    return { changed: false, turnCount: 0, updatedTurnSeqs: [] };
  }
  let turnCount = 0;
  for (const message of messages) {
    if (String(message?.role ?? "").toLowerCase() === "user") {
      turnCount += 1;
    }
  }
  if (turnCount === 0) {
    return { changed: false, turnCount: 0, updatedTurnSeqs: [] };
  }
  const updatedTurnSeqs: number[] = [];
  for (let turnSeq = 1; turnSeq <= turnCount; turnSeq += 1) {
    const record = await buildRawSemanticTurnRecordFromTranscript(sessionId, turnSeq, helpers);
    if (!record) continue;
    const existing = await loadRawSemanticTurnRecord(stateDir, sessionId, turnSeq);
    const nextMessages = dedupeRawSemanticMessages(record.messages);
    const nextToolCalls = dedupeRawSemanticToolCalls(record.toolCalls);
    const nextToolResults = dedupeRawSemanticToolResults(record.toolResults);
    const same =
      existing
      && JSON.stringify(existing.messages) === JSON.stringify(nextMessages)
      && JSON.stringify(existing.toolCalls) === JSON.stringify(nextToolCalls)
      && JSON.stringify(existing.toolResults) === JSON.stringify(nextToolResults);
    if (same) continue;
    await persistRawSemanticTurnRecord(stateDir, {
      ...record,
      messages: nextMessages,
      toolCalls: nextToolCalls,
      toolResults: nextToolResults,
    });
    updatedTurnSeqs.push(turnSeq);
  }
  return {
    changed: updatedTurnSeqs.length > 0,
    turnCount,
    updatedTurnSeqs,
  };
}
