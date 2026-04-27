/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ContextSegment, RuntimeTurnContext } from "../../../../kernel/src/types.js";

export type ProxyReductionBinding =
  | { segmentId: string; itemIndex: number; field: "arguments" | "output" | "result"; beforeLen: number }
  | {
    segmentId: string;
    itemIndex: number;
    field: "content";
    blockIndex?: number;
    blockKey?: "text" | "content";
    beforeLen: number;
  };

export type ReductionContextPassToggles = {
  repeatedReadDedup?: boolean;
  toolPayloadTrim?: boolean;
  htmlSlimming?: boolean;
  execOutputTruncation?: boolean;
  agentsStartupOptimization?: boolean;
};

export type BuildLayeredReductionContextResult = {
  turnCtx: RuntimeTurnContext;
  bindings: ProxyReductionBinding[];
  stats: {
    inputItems: number;
    toolLikeItems: number;
    persistedSkippedItems: number;
    candidateBlocks: number;
    overThresholdBlocks: number;
    instructionCount: number;
    enableToolPayloadTrim?: boolean;
    passToggles?: Record<string, boolean>;
  };
};

type BuildLayeredReductionContextDeps = {
  memoryFaultRecoverToolName: string;
  hasRecoveryMarker: (details: unknown) => boolean;
  inferObservationPayloadKind: (
    text: string,
    fallback?: unknown,
  ) => "stdout" | "stderr" | "json" | "blob" | undefined;
};

function isLikelyToolLikeInputItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const role = String(item.role ?? "").toLowerCase();
  const type = String(item.type ?? "").toLowerCase();
  if (role === "tool" || role === "observation" || role === "toolresult") return true;
  if (
    type === "function_call"
    || type === "function_call_output"
    || type === "tool_result"
    || type === "tool_call_output"
  ) return true;
  if (typeof item.name === "string" && item.name.trim().length > 0) return true;
  if (typeof item.tool_name === "string" && item.tool_name.trim().length > 0) return true;
  if (typeof item.toolName === "string" && item.toolName.trim().length > 0) return true;
  if (typeof item.tool_call_id === "string" && item.tool_call_id.trim().length > 0) return true;
  if (typeof item.toolCallId === "string" && item.toolCallId.trim().length > 0) return true;
  return false;
}

function isContextSafePersistedInputItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const details = item.details;
  if (details && typeof details === "object") {
    const contextSafe = (details as Record<string, unknown>).contextSafe;
    if (contextSafe && typeof contextSafe === "object") {
      const mode = String((contextSafe as Record<string, unknown>).resultMode ?? "").toLowerCase();
      if (mode === "artifact" || mode === "inline-fallback") return true;
      if ((contextSafe as Record<string, unknown>).excludedFromContext === true) return true;
    }
  }
  const markers = ["[persisted tool result]"];
  if (typeof item.content === "string" && markers.some((marker) => item.content.includes(marker))) return true;
  if (Array.isArray(item.content)) {
    for (const block of item.content) {
      if (!block || typeof block !== "object") continue;
      const text =
        typeof (block as Record<string, unknown>).text === "string"
          ? String((block as Record<string, unknown>).text)
          : typeof (block as Record<string, unknown>).content === "string"
            ? String((block as Record<string, unknown>).content)
            : "";
      if (markers.some((marker) => text.includes(marker))) return true;
    }
  }
  return false;
}

function detectToolPayloadKind(
  text: string,
  deps: BuildLayeredReductionContextDeps,
): "stdout" | "stderr" | "json" | "blob" | undefined {
  return deps.inferObservationPayloadKind(text);
}

function extractPathLike(value: any): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value.path ?? value.file_path ?? value.filePath;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function parseFunctionCallArgsMapFromInput(input: any[]): Map<string, { toolName?: string; path?: string }> {
  const map = new Map<string, { toolName?: string; path?: string }>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    const callId = String(
      item.call_id
      ?? item.tool_call_id
      ?? item.toolCallId
      ?? item.id
      ?? "",
    ).trim();
    if (!callId) continue;

    let toolName =
      typeof item.name === "string" && item.name.trim().length > 0
        ? item.name.trim()
        : typeof item.tool_name === "string" && item.tool_name.trim().length > 0
          ? item.tool_name.trim()
          : typeof item.toolName === "string" && item.toolName.trim().length > 0
            ? item.toolName.trim()
            : undefined;

    let path = extractPathLike(item) ?? extractPathLike(item?.details);
    if (!path) {
      try {
        const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
        path = extractPathLike(args);
      } catch {
        // Ignore malformed tool arguments.
      }
    }

    if ((type === "message" || !type) && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!block || typeof block !== "object") continue;
        const blockType = String(block.type ?? "").toLowerCase();
        if (blockType !== "toolcall" && blockType !== "tool_call") continue;
        const nestedCallId = String(block.id ?? block.call_id ?? "").trim();
        if (!nestedCallId) continue;
        const nestedToolName =
          typeof block.name === "string" && block.name.trim().length > 0 ? block.name.trim() : undefined;
        const nestedPath =
          extractPathLike(block)
          ?? (() => {
            try {
              const args = typeof block.arguments === "string" ? JSON.parse(block.arguments) : block.arguments;
              return extractPathLike(args);
            } catch {
              return undefined;
            }
          })();
        map.set(nestedCallId, { toolName: nestedToolName, path: nestedPath });
      }
    }

    if (type !== "function_call" && type !== "tool_call" && type !== "toolcall" && type !== "message") {
      map.set(callId, { toolName, path });
      continue;
    }
    map.set(callId, { toolName, path });
  }
  return map;
}

export function buildLayeredReductionContext(
  payload: any,
  triggerMinChars: number,
  sessionId: string,
  deps: BuildLayeredReductionContextDeps,
  passToggles?: ReductionContextPassToggles,
  passOptions?: Record<string, Record<string, unknown>>,
  segmentAnchorByCallId?: Map<string, { turnAbsIds: string[]; taskIds: string[] }>,
  orderedTurnAnchors?: Array<{ turnAbsId: string; taskIds: string[] }>,
): BuildLayeredReductionContextResult {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const callArgsMap = parseFunctionCallArgsMapFromInput(input);
  const segments: ContextSegment[] = [];
  const bindings: ProxyReductionBinding[] = [];
  const reductionInstructions: Array<{
    strategy: string;
    segmentIds: string[];
    parameters?: Record<string, unknown>;
  }> = [];

  const addSegment = (
    segmentId: string,
    text: string,
    metadata: Record<string, unknown>,
    binding: ProxyReductionBinding,
  ): void => {
    segments.push({
      id: segmentId,
      kind: "volatile",
      text,
      priority: 100,
      source: "proxy.input",
      metadata,
    });
    bindings.push(binding);
  };

  const readByPath = new Map<string, string[]>();
  const enableRepeatedReadDedup = passToggles?.repeatedReadDedup ?? true;
  const enableToolPayloadTrim = passToggles?.toolPayloadTrim ?? true;
  const enableHtmlSlimming = passToggles?.htmlSlimming ?? true;
  const enableExecOutputTruncation = passToggles?.execOutputTruncation ?? true;
  const execOutputOptions = passOptions?.exec_output_truncation ?? {};
  const execOutputToolThresholds =
    execOutputOptions.toolThresholds && typeof execOutputOptions.toolThresholds === "object"
      ? execOutputOptions.toolThresholds as Record<string, number>
      : undefined;
  const EXEC_OUTPUT_DEFAULT_THRESHOLD_CHARS = 50_000;
  const EXEC_OUTPUT_TOOL_THRESHOLDS: Record<string, number> = {
    bash: 30_000,
    shell: 30_000,
    powershell: 30_000,
    grep: 20_000,
    rg: 20_000,
    read: Number.POSITIVE_INFINITY,
    file_read: Number.POSITIVE_INFINITY,
    mcp_auth: 10_000,
    glob: 100_000,
    write: 100_000,
    edit: 100_000,
    file_write: 100_000,
    file_edit: 100_000,
    web_fetch: 100_000,
    web_search: 100_000,
    agent: 100_000,
    task: 100_000,
  };
  const getExecOutputThreshold = (rawToolName: string): number => {
    const normalizedToolName = rawToolName.trim().toLowerCase();
    if (!normalizedToolName) return EXEC_OUTPUT_DEFAULT_THRESHOLD_CHARS;
    if (
      execOutputToolThresholds &&
      typeof execOutputToolThresholds[normalizedToolName] === "number" &&
      Number.isFinite(execOutputToolThresholds[normalizedToolName])
    ) {
      return execOutputToolThresholds[normalizedToolName] as number;
    }
    return EXEC_OUTPUT_TOOL_THRESHOLDS[normalizedToolName] ?? EXEC_OUTPUT_DEFAULT_THRESHOLD_CHARS;
  };
  let toolLikeItems = 0;
  let persistedSkippedItems = 0;
  let candidateBlocks = 0;
  let overThresholdBlocks = 0;
  let orderedTurnIndex = -1;
  let currentOrderedAnchor: { turnAbsIds: string[]; taskIds: string[] } | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    if (String(item.role ?? "").toLowerCase() === "user" && orderedTurnAnchors) {
      const nextAnchor = orderedTurnAnchors[orderedTurnIndex + 1];
      if (nextAnchor) {
        orderedTurnIndex += 1;
        currentOrderedAnchor = {
          turnAbsIds: [nextAnchor.turnAbsId],
          taskIds: nextAnchor.taskIds,
        };
      }
    }
    if (!isLikelyToolLikeInputItem(item)) continue;
    if (isContextSafePersistedInputItem(item)) {
      persistedSkippedItems += 1;
      continue;
    }
    toolLikeItems += 1;

    const itemType = String(item.type ?? "").toLowerCase();
    const itemRole = String(item.role ?? "").toLowerCase();
    const callId = String(item.call_id ?? item.tool_call_id ?? item.id ?? "").trim();
    const callMeta = callId ? callArgsMap.get(callId) : undefined;
    const anchored = (callId ? segmentAnchorByCallId?.get(callId) : undefined) ?? currentOrderedAnchor;
    const toolName = String(
      item.name
      ?? item.tool_name
      ?? item.toolName
      ?? callMeta?.toolName
      ?? "",
    ).trim();
    const isMemoryFaultRecoveryTool =
      toolName.toLowerCase() === deps.memoryFaultRecoverToolName
      || deps.hasRecoveryMarker(item?.details);
    const directPath =
      extractPathLike(item)
      ?? extractPathLike(item?.details)
      ?? (() => {
        try {
          const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
          return extractPathLike(args);
        } catch {
          return undefined;
        }
      })();
    const dataPath = String(callMeta?.path ?? directPath ?? "").trim();

    const addReductionInstructions = (segmentId: string, text: string): void => {
      candidateBlocks += 1;
      const execOutputThreshold = getExecOutputThreshold(toolName);
      const overThreshold = text.length >= execOutputThreshold;
      if (overThreshold) {
        overThresholdBlocks += 1;
      }
      const payloadKind = detectToolPayloadKind(text, deps) ?? "stdout";
      if (enableToolPayloadTrim) {
        reductionInstructions.push({
          strategy: "tool_payload_trim",
          segmentIds: [segmentId],
          parameters: { payloadKind },
        });
        if (enableHtmlSlimming) {
          reductionInstructions.push({
            strategy: "html_slimming",
            segmentIds: [segmentId],
          });
        }
      }
      if (overThreshold && enableExecOutputTruncation) {
        reductionInstructions.push({
          strategy: "exec_output_truncation",
          segmentIds: [segmentId],
          parameters: {
            toolName: toolName || undefined,
            thresholdChars: Number.isFinite(execOutputThreshold) ? execOutputThreshold : undefined,
          },
        });
      }
    };

    const pushBindingForField = (
      fieldName: "arguments" | "output" | "result",
      applyReduction: boolean,
    ): void => {
      const text = item[fieldName];
      if (typeof text !== "string" || text.length === 0) return;
      const segmentId = `proxy-${index}-${fieldName}`;
      addSegment(
        segmentId,
        text,
        {
          toolName,
          path: dataPath,
          turnAbsIds: anchored?.turnAbsIds,
          taskIds: anchored?.taskIds,
          itemType,
          itemRole,
          fieldName,
          recovery: isMemoryFaultRecoveryTool
            ? {
                source: deps.memoryFaultRecoverToolName,
                skipReduction: true,
              }
            : undefined,
          toolPayload: {
            toolName,
            path: dataPath,
            turnAbsIds: anchored?.turnAbsIds,
            taskIds: anchored?.taskIds,
            payloadKind: detectToolPayloadKind(text, deps) ?? "stdout",
          },
        },
        { segmentId, itemIndex: index, field: fieldName, beforeLen: text.length },
      );
      if (applyReduction && !isMemoryFaultRecoveryTool) {
        addReductionInstructions(segmentId, text);
      }
      if (toolName === "read" && dataPath && fieldName !== "arguments") {
        const bucket = readByPath.get(dataPath) ?? [];
        bucket.push(segmentId);
        readByPath.set(dataPath, bucket);
      }
    };

    pushBindingForField("arguments", false);
    pushBindingForField("output", true);
    pushBindingForField("result", true);

    if (typeof item.content === "string" && item.content.length > 0) {
      const segmentId = `proxy-${index}-content`;
      addSegment(
        segmentId,
        item.content,
        {
          toolName,
          path: dataPath,
          turnAbsIds: anchored?.turnAbsIds,
          taskIds: anchored?.taskIds,
          itemType,
          itemRole,
          fieldName: "content",
          recovery: isMemoryFaultRecoveryTool
            ? {
                source: deps.memoryFaultRecoverToolName,
                skipReduction: true,
              }
            : undefined,
          toolPayload: {
            toolName,
            path: dataPath,
            turnAbsIds: anchored?.turnAbsIds,
            taskIds: anchored?.taskIds,
            payloadKind: detectToolPayloadKind(item.content, deps) ?? "stdout",
          },
        },
        { segmentId, itemIndex: index, field: "content", beforeLen: item.content.length },
      );
      if (!isMemoryFaultRecoveryTool) {
        addReductionInstructions(segmentId, item.content);
      }
      if (toolName === "read" && dataPath) {
        const bucket = readByPath.get(dataPath) ?? [];
        bucket.push(segmentId);
        readByPath.set(dataPath, bucket);
      }
    }
    if (Array.isArray(item.content)) {
      item.content.forEach((block: any, blockIndex: number) => {
        if (!block || typeof block !== "object") return;
        const blockKey: "text" | "content" | undefined =
          typeof block.text === "string"
            ? "text"
            : typeof block.content === "string"
              ? "content"
              : undefined;
        if (!blockKey) return;
        const text = String(block[blockKey] ?? "");
        if (!text) return;
        const segmentId = `proxy-${index}-content-${blockIndex}-${blockKey}`;
        addSegment(
          segmentId,
          text,
          {
            toolName,
            path: dataPath,
            turnAbsIds: anchored?.turnAbsIds,
            taskIds: anchored?.taskIds,
            itemType,
            itemRole,
            fieldName: "content",
            blockIndex,
            blockKey,
            recovery: isMemoryFaultRecoveryTool
              ? {
                  source: deps.memoryFaultRecoverToolName,
                  skipReduction: true,
                }
              : undefined,
            toolPayload: {
              toolName,
              path: dataPath,
              turnAbsIds: anchored?.turnAbsIds,
              taskIds: anchored?.taskIds,
              payloadKind: detectToolPayloadKind(text, deps) ?? "stdout",
            },
          },
          {
            segmentId,
            itemIndex: index,
            field: "content",
            blockIndex,
            blockKey,
            beforeLen: text.length,
          },
        );
        if (!isMemoryFaultRecoveryTool) {
          addReductionInstructions(segmentId, text);
        }
        if (toolName === "read" && dataPath) {
          const bucket = readByPath.get(dataPath) ?? [];
          bucket.push(segmentId);
          readByPath.set(dataPath, bucket);
        }
      });
    }
  }

  if (enableRepeatedReadDedup) {
    for (const segmentIds of readByPath.values()) {
      if (segmentIds.length < 2) continue;
      const [firstId, ...rest] = segmentIds;
      for (const segmentId of rest) {
        reductionInstructions.push({
          strategy: "repeated_read_dedup",
          segmentIds: [segmentId],
          parameters: { firstReadSegmentId: firstId },
        });
      }
    }
  }

  const turnCtx: RuntimeTurnContext = {
    sessionId: sessionId.trim() || "proxy-session",
    sessionMode: "single",
    provider: "openai",
    model: String(payload?.model ?? "unknown"),
    apiFamily: "openai-responses",
    prompt: "",
    segments,
    budget: {
      maxInputTokens: 1_000_000,
      reserveOutputTokens: 16_384,
    },
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: [
              enableRepeatedReadDedup ? "repeated_read_dedup" : null,
              enableToolPayloadTrim ? "tool_payload_trim" : null,
              enableHtmlSlimming ? "html_slimming" : null,
              enableExecOutputTruncation ? "exec_output_truncation" : null,
            ].filter(Boolean) as string[],
            instructions: reductionInstructions,
          },
        },
      },
    },
  };

  return {
    turnCtx,
    bindings,
    stats: {
      inputItems: input.length,
      toolLikeItems,
      persistedSkippedItems,
      candidateBlocks,
      overThresholdBlocks,
      instructionCount: reductionInstructions.length,
      enableToolPayloadTrim,
      passToggles: {
        repeatedReadDedup: enableRepeatedReadDedup,
        toolPayloadTrim: enableToolPayloadTrim,
        htmlSlimming: enableHtmlSlimming,
        execOutputTruncation: enableExecOutputTruncation,
      },
    },
  };
}
