import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildArchiveLocation,
  buildRecoveryHint,
} from "./index.js";
import { hashText, pluginStateSubdir } from "./archive-paths.js";

export function buildToolResultPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[ecoclaw preview truncated]`;
}

export function toolInlineLimit(toolName: string): number {
  if (toolName === "read") return 12_000;
  if (toolName === "exec" || toolName === "bash" || toolName === "web_fetch") return 4_000;
  return 8_000;
}

function updateArchiveLookupSync(
  dataKey: string,
  archivePath: string,
  archiveDir: string,
): void {
  const keyDir = join(archiveDir, "keys");
  const keyPath = join(keyDir, `${hashText(dataKey)}.json`);
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(
    keyPath,
    JSON.stringify({ dataKey, archivePath }, null, 2),
    "utf8",
  );

  const lookupPath = join(archiveDir, "key-lookup.json");
  let lookup: Record<string, string> = {};
  try {
    lookup = JSON.parse(readFileSync(lookupPath, "utf8")) as Record<string, string>;
  } catch {
    lookup = {};
  }
  lookup[dataKey] = archivePath;
  writeFileSync(lookupPath, JSON.stringify(lookup, null, 2), "utf8");
}

function archiveContentSync(params: {
  sessionId: string;
  segmentId: string;
  sourcePass: string;
  toolName: string;
  dataKey: string;
  originalText: string;
  archiveDir: string;
  metadata?: Record<string, unknown>;
}): { archivePath: string; archiveDir: string } {
  const { archiveDir, archivePath } = buildArchiveLocation(params);
  mkdirSync(dirname(archivePath), { recursive: true });
  const entry = {
    schemaVersion: 1,
    kind: `${params.sourcePass}_archive`,
    sessionId: params.sessionId,
    segmentId: params.segmentId,
    sourcePass: params.sourcePass,
    toolName: params.toolName,
    dataKey: params.dataKey,
    originalText: params.originalText,
    originalSize: params.originalText.length,
    archivedAt: new Date().toISOString(),
    metadata: params.metadata,
  };
  writeFileSync(archivePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  updateArchiveLookupSync(params.dataKey, archivePath, archiveDir);
  return { archivePath, archiveDir };
}

export function resolveToolNameFromPersistEvent(event: any): string {
  return String(
    event?.toolName ??
      event?.tool_name ??
      event?.message?.toolName ??
      event?.message?.tool_name ??
      "",
  ).trim().toLowerCase();
}

export type ToolResultPersistOutcome = {
  toolName: string;
  inlineLimit: number;
  originalChars: number;
  dataKey?: string;
  outputFile?: string;
  resultMode: "inline" | "artifact" | "inline-fallback";
  previewText?: string;
  noticeText?: string;
  recoveryHint?: string;
  sourcePass?: "tool_result_persist";
  persistedBy?: "ecoclaw.tool_result_persist";
};

export function planToolResultPersistence(params: {
  event: any;
  text: string;
  stateDir: string;
  safeId: (value: string) => string;
}): ToolResultPersistOutcome {
  const toolName = resolveToolNameFromPersistEvent(params.event);
  const limit = toolInlineLimit(toolName);
  const text = String(params.text ?? "");
  if (text.length <= limit) {
    return {
      toolName,
      inlineLimit: limit,
      originalChars: text.length,
      resultMode: "inline",
    };
  }

  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const callId = String(params.event?.toolCallId ?? params.event?.tool_call_id ?? "").trim();
  const toolPart = params.safeId(toolName || "tool");
  const dataKey = `tool_result_persist:${toolPart}:${callId ? params.safeId(callId) : digest}`;

  let outputFile: string | undefined;
  try {
    const archived = archiveContentSync({
      sessionId: "proxy-session",
      segmentId: callId || `${toolPart}-${digest}`,
      sourcePass: "tool_result_persist",
      toolName: toolName || "tool",
      dataKey,
      originalText: text,
      archiveDir: pluginStateSubdir(params.stateDir, "artifacts", toolPart),
      metadata: {
        toolCallId: callId || undefined,
        persistedBy: "ecoclaw.tool_result_persist",
      },
    });
    outputFile = archived.archivePath;
  } catch {
    outputFile = undefined;
  }

  const previewText = buildToolResultPreview(text, limit);
  const noticeText = outputFile
    ? `[ecoclaw persisted tool_result] full output moved to: ${outputFile}`
    : "[ecoclaw persisted tool_result] artifact write failed, using inline preview fallback";
  const recoveryHint = outputFile
    ? buildRecoveryHint({
        dataKey,
        originalSize: text.length,
        archivePath: outputFile,
        sourceLabel: "tool_result_persist",
      })
    : "";

  return {
    toolName,
    inlineLimit: limit,
    originalChars: text.length,
    dataKey,
    outputFile,
    resultMode: outputFile ? "artifact" : "inline-fallback",
    previewText,
    noticeText,
    recoveryHint,
    sourcePass: "tool_result_persist",
    persistedBy: "ecoclaw.tool_result_persist",
  };
}
