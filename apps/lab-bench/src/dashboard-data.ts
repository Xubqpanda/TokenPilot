import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextSegment, UsageSnapshot } from "@ecoclaw/kernel";

type UnknownRecord = Record<string, unknown>;

type RawTraceEntry = {
  at: string;
  logicalSessionId?: string;
  physicalSessionId?: string;
  branch?: UnknownRecord;
  provider?: string;
  model?: string;
  apiFamily?: string;
  prompt?: string;
  usage?: UsageSnapshot;
  contextDetail?: UnknownRecord;
  initialContext?: UnknownRecord;
  finalContext?: UnknownRecord;
  moduleSteps?: unknown[];
  eventTypes?: string[];
  finalContextEvents?: unknown[];
  resultEvents?: unknown[];
  responsePreview?: string;
};

export type DashboardSessionSummary = {
  id: string;
  stateRoot: string;
  turnCount: number;
  lastAt: string;
  provider: string;
  model: string;
  apiFamily: string;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  latestTraceId: string;
};

export type DashboardTurnSummary = {
  traceId: string;
  sessionId: string;
  physicalSessionId?: string;
  at: string;
  provider: string;
  model: string;
  apiFamily: string;
  promptPreview: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  eventTypes: string[];
  stateRoot: string;
};

export type DashboardTurnTreeNode = {
  traceId: string;
  parentTraceId?: string;
  sessionId: string;
  physicalSessionId: string;
  isActiveReplayBranch?: boolean;
  branchLabel: string;
  at: string;
  promptPreview: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  branchStrategy?: string;
  planId?: string;
  eventTypes: string[];
};

export type DashboardTurnTree = {
  sessionId: string;
  selectedTraceId?: string;
  activePhysicalSessionId?: string;
  rootTraceIds: string[];
  nodes: DashboardTurnTreeNode[];
};

export type DashboardSegmentView = {
  id: string;
  kind: string;
  source?: string;
  priority: number;
  text: string;
  chars: number;
  prefixZone: "stable_prefix" | "prefix_edge" | "tail";
  changeType: "unchanged" | "modified" | "added" | "removed";
  isToolPayload: boolean;
  payloadKind?: string;
};

export type DashboardProviderEntry = {
  at: string;
  deltaMs: number;
  stage?: string;
  method?: string;
  status?: number;
  url?: string;
  promptCacheRetention?: string | null;
  requestBodyPreview?: string;
  responseBodyPreview?: string;
  responseText?: string;
  promptCacheKey?: string | null;
  requestBody?: string;
  responseBody?: unknown;
  requestJson?: unknown;
  responseJson?: unknown;
  payload?: unknown;
};

export type DashboardTurnDetail = {
  traceId: string;
  sessionId: string;
  physicalSessionId?: string;
  at: string;
  provider: string;
  model: string;
  apiFamily: string;
  prompt: string;
  promptPreview: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    netTokens: number;
    cacheHitRate: number | null;
  };
  prefix: {
    stableChars: number;
    stableSignature?: string;
    normalizedSignature?: string;
  };
  initialSegments: DashboardSegmentView[];
  finalSegments: DashboardSegmentView[];
  moduleSteps: unknown[];
  eventTypes: string[];
  finalContextEvents: unknown[];
  resultEvents: unknown[];
  policy?: UnknownRecord;
  reduction?: UnknownRecord;
  summary?: UnknownRecord;
  compaction?: UnknownRecord;
  requestDetail?: UnknownRecord;
  openclawPromptRoot?: string;
  responsePreview?: string;
  providerTraffic: DashboardProviderEntry[];
  stateRoot: string;
  conversation: DashboardConversationBlock[];
  actualForwardedConversation: DashboardConversationBlock[];
  replayConversation: DashboardConversationBlock[];
  turnTree: DashboardTurnTree;
};

export type DashboardConversationBlock = {
  id: string;
  turnId: string;
  turnIndex: number;
  at?: string;
  role: "system" | "user" | "assistant" | "tool";
  title: string;
  text: string;
  chars: number;
  source?: string;
  payloadKind?: string;
  toolName?: string;
};

export type DashboardDraftBlockInput = {
  draftId?: string;
  role?: "system" | "user" | "assistant" | "tool" | string;
  title?: string;
  text?: string;
  chars?: number;
  source?: string;
  sourceRefs?: string[];
  origin?: string;
  derivedLabel?: string;
};

export type DashboardDraftApplyResult = {
  ok: true;
  sessionId: string;
  physicalSessionId: string;
  traceId: string;
  sourceTraceId: string;
  anchorTraceId: string;
  divergenceIndex: number;
  cacheChars: number;
  newChars: number;
  seedBlockCount: number;
  userTurnCount: number;
  seedTextPreview: string;
  planPath: string;
  materializedTurnCount: number;
  materializedTraceIds: string[];
};

export type DashboardOverview = {
  stateRoots: string[];
  selectedStateRoot: string;
  sessions: DashboardSessionSummary[];
  recentTurns: DashboardTurnSummary[];
};

type IndexedTrace = {
  traceId: string;
  stateRoot: string;
  entry: RawTraceEntry;
};

type ManualBranchAction = "fork" | "revert";

type ManualBranchBinding = {
  physicalSessionId: string;
  sourceTraceId: string;
  sourcePhysicalSessionId: string;
  action: ManualBranchAction;
  updatedAt: string;
};

type ManualPlannedBranch = {
  logicalSessionId: string;
  physicalSessionId: string;
  parentPhysicalSessionId: string;
  sourceTraceId: string;
  action: ManualBranchAction;
  createdAt: string;
};

type ManualBranchControlFile = {
  updatedAt: string;
  bindings: Record<string, ManualBranchBinding>;
  plannedBranches: ManualPlannedBranch[];
};

type DraftApplyPlan = {
  schemaVersion: 1;
  createdAt: string;
  logicalSessionId: string;
  sourceTraceId: string;
  anchorTraceId: string;
  sourcePhysicalSessionId: string;
  targetPhysicalSessionId: string;
  divergenceIndex: number;
  cacheChars: number;
  newChars: number;
  seedBlocks: Array<{
    role: string;
    title: string;
    text: string;
    sourceRefs: string[];
  }>;
  seedText: string;
  userTurns: Array<{
    role: "user";
    title: string;
    text: string;
    sourceRefs: string[];
  }>;
  draftBlocks: DashboardDraftBlockInput[];
};

type DraftDivergenceStats = {
  divergenceIndex: number;
  cacheChars: number;
  newChars: number;
  blockSharedChars: number;
};

export type DashboardBranchActionResult = {
  ok: true;
  action: ManualBranchAction;
  sessionId: string;
  physicalSessionId: string;
  traceId: string;
  sourceTraceId: string;
};

const DEFAULT_STATE_ROOTS = [
  join(homedir(), ".openclaw", "ecoclaw-plugin-state", "ecoclaw"),
  "/tmp/ecoclaw-lab-state/ecoclaw",
];

const MAX_TRACE_LINES = 400;
const MAX_PROVIDER_LINES = 400;
const PROVIDER_MATCH_WINDOW_MS = 30_000;
const MAX_CONVERSATION_TURNS = 200;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseLines(text: string, maxLines: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines);
}

function safeBranchId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "branch";
}

async function readJsonlFile(path: string, maxLines: number): Promise<unknown[]> {
  if (!existsSync(path)) return [];
  const content = await readFile(path, "utf8");
  const lines = parseLines(content, maxLines);
  const rows: unknown[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore malformed lines to keep dashboard resilient
    }
  }
  return rows;
}

async function readSessionTurns(path: string): Promise<unknown[]> {
  if (!existsSync(path)) return [];
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_CONVERSATION_TURNS)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((item) => item !== undefined);
}

function usageOf(usage?: UsageSnapshot) {
  const providerRaw = asRecord(usage?.providerRaw);
  const inputTokens = asNumber(usage?.inputTokens ?? providerRaw?.input_tokens);
  const outputTokens = asNumber(usage?.outputTokens ?? providerRaw?.output_tokens);
  const cacheReadTokens = asNumber(
    usage?.cacheReadTokens ??
      usage?.cachedTokens ??
      asRecord(providerRaw?.prompt_tokens_details)?.cached_tokens ??
      providerRaw?.cacheRead,
  );
  const cacheHitRate = typeof usage?.cacheHitRate === "number" ? usage.cacheHitRate : null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheHitRate };
}

function latestEventPayload(events: unknown[], type: string): UnknownRecord | undefined {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = asRecord(events[idx]);
    if (!event || asString(event.type) !== type) continue;
    return asRecord(event.payload);
  }
  return undefined;
}

function isManualBranchScaffold(entry: RawTraceEntry): boolean {
  const eventTypes = Array.isArray(entry.eventTypes) ? entry.eventTypes.map((item) => String(item)) : [];
  if (eventTypes.includes("manual.branch.created")) return true;
  if (eventTypes.includes("draft.apply.planned")) return true;
  const prompt = asString(entry.prompt, "");
  return (
    prompt.startsWith("[manual fork]") ||
    prompt.startsWith("[manual revert]") ||
    prompt.startsWith("[draft apply]")
  );
}

type TraceBranchSnapshot = {
  logicalSessionId: string;
  physicalSessionId: string;
  forkedFromSessionId?: string;
  spawnedPhysicalSessionId?: string;
  spawnedFromPhysicalSessionId?: string;
  sourceTraceId?: string;
  branchStrategy?: string;
  planId?: string;
};

function traceBranchSnapshot(entry: RawTraceEntry): TraceBranchSnapshot {
  const logicalSessionId = asString(entry.logicalSessionId || entry.physicalSessionId, "unknown");
  const physicalSessionId = asString(entry.physicalSessionId || entry.logicalSessionId, logicalSessionId);
  const branch = asRecord(entry.branch);
  const contextDetail = asRecord(entry.contextDetail);
  const finalContext = asRecord(contextDetail?.finalContext);
  const finalMetadata = asRecord(finalContext?.metadata);
  const resultEvents = Array.isArray(entry.resultEvents) ? entry.resultEvents : [];
  const applyPayload = latestEventPayload(resultEvents, "compaction.apply.executed");

  return {
    logicalSessionId,
    physicalSessionId,
    forkedFromSessionId:
      asString(branch?.forkedFromSessionId) ||
      asString(finalMetadata?.forkedFromSessionId) ||
      undefined,
    spawnedPhysicalSessionId:
      asString(branch?.spawnedPhysicalSessionId) ||
      asString(applyPayload?.toPhysicalSessionId) ||
      undefined,
    spawnedFromPhysicalSessionId:
      asString(branch?.spawnedFromPhysicalSessionId) ||
      asString(applyPayload?.fromPhysicalSessionId) ||
      undefined,
    sourceTraceId:
      asString(branch?.sourceTraceId) ||
      asString(applyPayload?.sourceTraceId) ||
      asString(latestEventPayload(resultEvents, "manual.branch.created")?.sourceTraceId) ||
      undefined,
    branchStrategy:
      asString(branch?.branchStrategy) ||
      asString(applyPayload?.strategy) ||
      undefined,
    planId:
      asString(branch?.planId) ||
      asString(applyPayload?.planId) ||
      undefined,
  };
}

function conversationToolSegments(record: UnknownRecord): ContextSegment[] {
  const trace = asRecord(record.trace);
  const initialContext = asRecord(trace?.initialContext);
  const finalContext = asRecord(trace?.finalContext);
  const segmentPools = [
    Array.isArray(record.segments) ? (record.segments as ContextSegment[]) : [],
    Array.isArray(initialContext?.segments) ? (initialContext.segments as ContextSegment[]) : [],
    Array.isArray(finalContext?.segments) ? (finalContext.segments as ContextSegment[]) : [],
  ];
  const seen = new Set<string>();
  const matches: ContextSegment[] = [];

  for (const segments of segmentPools) {
    for (const segment of segments) {
      const metadata = asRecord(segment.metadata);
      const toolPayload = asRecord(metadata?.toolPayload);
      const reduction = asRecord(metadata?.reduction);
      const source = asString(segment.source);
      const isMatch = Boolean(
        metadata?.isToolPayload ||
          toolPayload?.enabled ||
          reduction?.target === "tool_payload" ||
          source.includes("tool") ||
          source.includes("observation"),
      );
      if (!isMatch) continue;
      const key = `${segment.id}::${segment.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(segment);
    }
  }

  return matches;
}

type ConversationTarget = {
  logicalSessionId: string;
  physicalSessionId?: string;
  targetAt?: string;
  targetPrompt?: string;
};

function conversationTurnsPath(stateRoot: string, target: ConversationTarget): string {
  const physicalSessionId = asString(target.physicalSessionId);
  const logicalSessionId = asString(target.logicalSessionId, "unknown");
  const candidates = [physicalSessionId, logicalSessionId].filter(Boolean);
  for (const sessionId of candidates) {
    const candidatePath = join(stateRoot, "sessions", sessionId, "turns.jsonl");
    if (existsSync(candidatePath)) return candidatePath;
  }
  return join(stateRoot, "sessions", logicalSessionId, "turns.jsonl");
}

function targetConversationIndex(rows: unknown[], target: ConversationTarget): number {
  if (!rows.length) return -1;
  const targetAt = asString(target.targetAt);
  const targetPrompt = asString(target.targetPrompt);

  const exactIndex = rows.findIndex((row) => {
    const record = asRecord(row);
    if (!record) return false;
    const sameAt = targetAt ? asString(record.startedAt || record.at) === targetAt : true;
    const samePrompt = targetPrompt ? asString(record.prompt) === targetPrompt : true;
    return sameAt && samePrompt;
  });
  if (exactIndex >= 0) return exactIndex;

  if (targetAt) {
    const targetMs = Date.parse(targetAt);
    if (Number.isFinite(targetMs)) {
      let bestIndex = -1;
      let bestDelta = Number.MAX_SAFE_INTEGER;
      rows.forEach((row, index) => {
        const record = asRecord(row);
        if (!record) return;
        if (targetPrompt && asString(record.prompt) !== targetPrompt) return;
        const rowMs = Date.parse(asString(record.startedAt || record.at));
        if (!Number.isFinite(rowMs)) return;
        const delta = Math.abs(rowMs - targetMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIndex = index;
        }
      });
      if (bestIndex >= 0) return bestIndex;
    }
  }

  if (targetPrompt) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const record = asRecord(rows[index]);
      if (record && asString(record.prompt) === targetPrompt) return index;
    }
  }

  return rows.length - 1;
}

async function loadConversationBlocks(target: ConversationTarget, stateRoot: string): Promise<DashboardConversationBlock[]> {
  const turnsPath = conversationTurnsPath(stateRoot, target);
  const rows = await readSessionTurns(turnsPath);
  if (!rows.length) return [];
  const cutoffIndex = targetConversationIndex(rows, target);
  if (cutoffIndex < 0) return [];

  const blocks: DashboardConversationBlock[] = [];
  let systemAdded = false;
  rows.slice(0, cutoffIndex + 1).forEach((row, index) => {
    const record = asRecord(row);
    if (!record) return;
    const turnId = asString(record.turnId, `turn-${index + 1}`);
    const turnIndex = index + 1;
    const trace = asRecord(record.trace);
    const initialContext = asRecord(trace?.initialContext);
    const initialSegments = Array.isArray(initialContext?.segments) ? (initialContext.segments as ContextSegment[]) : [];

    if (!systemAdded) {
      const rootSegment =
        initialSegments.find((segment) => asString(segment.source).includes("system")) ??
        initialSegments.find((segment) => segment.kind === "stable");
      if (rootSegment?.text) {
        blocks.push({
          id: `${turnId}:system`,
          turnId,
          turnIndex,
          role: "system",
          title: "Root/System Context",
          text: rootSegment.text,
          chars: rootSegment.text.length,
          source: rootSegment.source,
        });
        systemAdded = true;
      }
    }

    const prompt = asString(record.prompt);
    if (prompt) {
      blocks.push({
        id: `${turnId}:user`,
        turnId,
        turnIndex,
        at: asString(record.startedAt),
        role: "user",
        title: `Turn ${turnIndex} User`,
        text: prompt,
        chars: prompt.length,
      });
    }

    for (const segment of conversationToolSegments(record)) {
      const metadata = asRecord(segment.metadata);
      const toolPayload = asRecord(metadata?.toolPayload);
      blocks.push({
        id: `${turnId}:tool:${segment.id}`,
        turnId,
        turnIndex,
        at: asString(record.startedAt),
        role: "tool",
        title: `Turn ${turnIndex} Tool`,
        text: segment.text,
        chars: segment.text.length,
        source: segment.source,
        payloadKind: asString(metadata?.payloadKind || toolPayload?.kind),
        toolName: asString(toolPayload?.toolName),
      });
    }

    const response = asString(record.response || record.responsePreview);
    if (response) {
      blocks.push({
        id: `${turnId}:assistant`,
        turnId,
        turnIndex,
        at: asString(record.endedAt),
        role: "assistant",
        title: `Turn ${turnIndex} Assistant`,
        text: response,
        chars: response.length,
      });
    }
  });

  return blocks;
}

function traceIdOf(entry: RawTraceEntry, stateRoot: string): string {
  const hash = createHash("sha1")
    .update(stateRoot)
    .update("|")
    .update(asString(entry.logicalSessionId, "unknown"))
    .update("|")
    .update(asString(entry.at, "unknown"))
    .update("|")
    .update(asString(entry.prompt, ""))
    .digest("hex");
  return hash.slice(0, 16);
}

function branchLabel(physicalSessionId: string, logicalSessionId: string): string {
  if (physicalSessionId === logicalSessionId) return "main";
  const forkMatch = physicalSessionId.match(/-f(\d{4,})$/);
  if (forkMatch) return `fork ${forkMatch[1]}`;
  const manualMatch = physicalSessionId.match(/-(mf|rv)(\d{4,})$/);
  if (manualMatch) return `${manualMatch[1] === "mf" ? "fork" : "revert"} ${manualMatch[2]}`;
  if (physicalSessionId.length <= 28) return physicalSessionId;
  return `branch ${physicalSessionId.slice(-18)}`;
}

async function buildTurnTree(
  traces: IndexedTrace[],
  stateRoot: string,
  sessionId: string,
  preferredTraceId?: string,
): Promise<DashboardTurnTree> {
  const sessionTraces = traces.filter(
    (trace) =>
      asString(trace.entry.logicalSessionId || trace.entry.physicalSessionId, "unknown") === sessionId &&
      !isManualBranchScaffold(trace.entry),
  );
  const manualControl = await readManualBranchControl(stateRoot);
  const activePhysicalSessionId = asString(manualControl.bindings[sessionId]?.physicalSessionId, sessionId);
  const plannedByPhysical = new Map(
    manualControl.plannedBranches
      .filter((item) => item.logicalSessionId === sessionId)
      .map((item) => [item.physicalSessionId, item] as const),
  );

  if (sessionTraces.length === 0) {
    return {
      sessionId,
      selectedTraceId: preferredTraceId,
      activePhysicalSessionId,
      rootTraceIds: [],
      nodes: [],
    };
  }

  const sorted = sessionTraces.slice().sort((a, b) => {
    const aAt = asString(a.entry.at);
    const bAt = asString(b.entry.at);
    if (aAt !== bAt) return aAt.localeCompare(bAt);
    return a.traceId.localeCompare(b.traceId);
  });
  const lastTraceByPhysical = new Map<string, string>();
  const nodes: DashboardTurnTreeNode[] = [];
  const rootTraceIds: string[] = [];

  for (const trace of sorted) {
    const snapshot = traceBranchSnapshot(trace.entry);
    const usage = usageOf(trace.entry.usage);
    const planned = plannedByPhysical.get(snapshot.physicalSessionId);
    const parentPhysicalSessionId =
      planned?.parentPhysicalSessionId ||
      snapshot.forkedFromSessionId ||
      snapshot.spawnedFromPhysicalSessionId;
    const parentTraceId =
      lastTraceByPhysical.get(snapshot.physicalSessionId) ||
      snapshot.sourceTraceId ||
      planned?.sourceTraceId ||
      (parentPhysicalSessionId ? lastTraceByPhysical.get(parentPhysicalSessionId) : undefined);

    if (!parentTraceId) rootTraceIds.push(trace.traceId);
    nodes.push({
      traceId: trace.traceId,
      parentTraceId,
      sessionId,
      physicalSessionId: snapshot.physicalSessionId,
      isActiveReplayBranch: snapshot.physicalSessionId === activePhysicalSessionId,
      branchLabel: branchLabel(snapshot.physicalSessionId, snapshot.logicalSessionId),
      at: asString(trace.entry.at),
      promptPreview: previewOf(asString(trace.entry.prompt, ""), 90),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      branchStrategy: snapshot.branchStrategy || planned?.action,
      planId: snapshot.planId,
      eventTypes: Array.isArray(trace.entry.eventTypes) ? trace.entry.eventTypes.map((item) => String(item)) : [],
    });
    lastTraceByPhysical.set(snapshot.physicalSessionId, trace.traceId);
  }

  const nodeIds = new Set(nodes.map((node) => node.traceId));
  const normalizedRoots = rootTraceIds.filter((traceId, index) => rootTraceIds.indexOf(traceId) === index);
  const fallbackSelected =
    preferredTraceId && nodeIds.has(preferredTraceId)
      ? preferredTraceId
      : nodes.slice().sort((a, b) => b.at.localeCompare(a.at))[0]?.traceId;
  return {
    sessionId,
    selectedTraceId: fallbackSelected,
    activePhysicalSessionId,
    rootTraceIds: normalizedRoots,
    nodes,
  };
}

function previewOf(text: string, max = 140): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeDraftBlockInput(input: DashboardDraftBlockInput): DashboardDraftBlockInput {
  return {
    draftId: asString(input.draftId, ""),
    role: normalizeForwardedRole(asString(input.role, "user")),
    title: asString(input.title, "Message"),
    text: asString(input.text, "").trim(),
    chars: asNumber(input.chars, asString(input.text, "").length),
    source: asString(input.source, "draft"),
    sourceRefs: Array.isArray(input.sourceRefs)
      ? input.sourceRefs.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [],
    origin: asString(input.origin, "source"),
    derivedLabel: asString(input.derivedLabel, ""),
  };
}

function isDraftBlockEquivalentToSource(
  draft: DashboardDraftBlockInput | undefined,
  source: DashboardConversationBlock | undefined,
): boolean {
  if (!draft || !source) return false;
  const refs = Array.isArray(draft.sourceRefs) ? draft.sourceRefs : [];
  return (
    draft.origin === "source" &&
    refs.length === 1 &&
    refs[0] === source.id &&
    normalizeForwardedRole(asString(draft.role, "user")) === source.role &&
    asString(draft.text, "") === source.text
  );
}

function computeDraftDivergenceIndex(
  sourceBlocks: DashboardConversationBlock[],
  draftBlocks: DashboardDraftBlockInput[],
): number {
  const maxLen = Math.max(sourceBlocks.length, draftBlocks.length);
  for (let index = 0; index < maxLen; index += 1) {
    if (isDraftBlockEquivalentToSource(draftBlocks[index], sourceBlocks[index])) continue;
    return index;
  }
  return -1;
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

function computeDraftDivergenceStats(
  sourceBlocks: DashboardConversationBlock[],
  draftBlocks: DashboardDraftBlockInput[],
): DraftDivergenceStats {
  const totalDraftChars = draftBlocks.reduce((sum, block) => sum + asString(block.text, "").length, 0);
  let cacheChars = 0;
  const maxLen = Math.max(sourceBlocks.length, draftBlocks.length);
  for (let index = 0; index < maxLen; index += 1) {
    const sourceBlock = sourceBlocks[index];
    const draftBlock = draftBlocks[index];
    if (isDraftBlockEquivalentToSource(draftBlock, sourceBlock)) {
      cacheChars += asString(draftBlock?.text, "").length;
      continue;
    }

    let blockSharedChars = 0;
    if (
      sourceBlock &&
      draftBlock &&
      normalizeForwardedRole(asString(draftBlock.role, "user")) === sourceBlock.role
    ) {
      blockSharedChars = commonPrefixLength(sourceBlock.text, asString(draftBlock.text, ""));
      cacheChars += blockSharedChars;
    }

    return {
      divergenceIndex: index,
      cacheChars,
      newChars: Math.max(0, totalDraftChars - cacheChars),
      blockSharedChars,
    };
  }

  return {
    divergenceIndex: -1,
    cacheChars: totalDraftChars,
    newChars: 0,
    blockSharedChars: 0,
  };
}

function sourceBlockById(blocks: DashboardConversationBlock[]): Map<string, DashboardConversationBlock> {
  return new Map(blocks.map((block) => [block.id, block]));
}

function buildDraftSeedText(blocks: DashboardDraftBlockInput[]): string {
  return blocks
    .map((block) => {
      const title = asString(block.title, "Message");
      const role = normalizeForwardedRole(asString(block.role, "user"));
      return `[${role.toUpperCase()}] ${title}\n${asString(block.text, "").trim()}`.trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

function contentPartToText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) return contentValueToText(record.content);
  return "";
}

function contentValueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => contentPartToText(item))
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n");
  }
  return contentPartToText(value);
}

function normalizeForwardedRole(role: string): DashboardConversationBlock["role"] {
  const normalized = role.trim().toLowerCase();
  if (normalized === "developer" || normalized === "system") return "system";
  if (normalized === "assistant") return "assistant";
  if (normalized === "tool") return "tool";
  return "user";
}

function forwardedTitle(role: string, index: number): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "developer") return "Forwarded Developer Context";
  if (normalized === "system") return "Forwarded System Instructions";
  if (normalized === "assistant") return `Forwarded Assistant Input ${index}`;
  if (normalized === "tool") return `Forwarded Tool Input ${index}`;
  return `Forwarded User Input ${index}`;
}

function buildForwardedBlocksFromPayload(
  payload: UnknownRecord | undefined,
  turnId: string,
  turnIndex: number,
  at?: string,
  assistantResponseText?: string,
  assistantSource?: string,
): DashboardConversationBlock[] {
  if (!payload) return [];
  const blocks: DashboardConversationBlock[] = [];
  const instructions = asString(payload.instructions);
  if (instructions) {
    blocks.push({
      id: `${turnId}:forwarded:instructions`,
      turnId,
      turnIndex,
      at,
      role: "system",
      title: "Forwarded Instructions",
      text: instructions,
      chars: instructions.length,
      source: "proxy_forwarded.instructions",
    });
  }

  const inputItems = Array.isArray(payload.input)
    ? payload.input
    : Array.isArray(payload.messages)
      ? payload.messages
      : [];
  inputItems.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) return;
    const roleText = asString(record.role, "user");
    const text = contentValueToText(record.content ?? record.input_text ?? record.text);
    if (!text.trim()) return;
    const role = normalizeForwardedRole(roleText);
    blocks.push({
      id: `${turnId}:forwarded:${index}`,
      turnId,
      turnIndex,
      at,
      role,
      title: forwardedTitle(roleText, index + 1),
      text,
      chars: text.length,
      source: `proxy_forwarded.${roleText || "input"}`,
    });
  });

  const prompt = asString(payload.prompt);
  if (!blocks.length && prompt) {
    blocks.push({
      id: `${turnId}:forwarded:prompt`,
      turnId,
      turnIndex,
      at,
      role: "user",
      title: "Forwarded Prompt",
      text: prompt,
      chars: prompt.length,
      source: "proxy_forwarded.prompt",
    });
  }

  const assistantText = asString(assistantResponseText).trim();
  if (assistantText) {
    blocks.push({
      id: `${turnId}:forwarded:assistant`,
      turnId,
      turnIndex,
      at,
      role: "assistant",
      title: "Forwarded Assistant Response",
      text: assistantText,
      chars: assistantText.length,
      source: assistantSource || "provider.response",
    });
  }

  return blocks;
}

function pickForwardedPayloadEntry(entries: DashboardProviderEntry[]): DashboardProviderEntry | undefined {
  return (
    entries.find((entry) => String(entry.stage ?? "").includes("proxy_forwarded") && asRecord(entry.payload)) ??
    entries.find((entry) => String(entry.stage ?? "").includes("proxy_forwarded") && asRecord(entry.requestJson)) ??
    entries.find((entry) => String(entry.stage ?? "").includes("provider_rewrite") && asRecord(entry.requestJson)) ??
    entries.find((entry) => asRecord(entry.requestJson))
  );
}

function segmentChangeMap(initialSegments: ContextSegment[], finalSegments: ContextSegment[]) {
  const initialById = new Map(initialSegments.map((segment) => [segment.id, segment]));
  const finalById = new Map(finalSegments.map((segment) => [segment.id, segment]));
  return {
    initialChangeType(segment: ContextSegment): DashboardSegmentView["changeType"] {
      const match = finalById.get(segment.id);
      if (!match) return "removed";
      if (match.text !== segment.text) return "modified";
      return "unchanged";
    },
    finalChangeType(segment: ContextSegment): DashboardSegmentView["changeType"] {
      const match = initialById.get(segment.id);
      if (!match) return "added";
      if (match.text !== segment.text) return "modified";
      return "unchanged";
    },
  };
}

function controlsPath(stateRoot: string): string {
  return join(stateRoot, "controls", "manual-branch-routing.json");
}

function draftApplyPlanPath(stateRoot: string, physicalSessionId: string): string {
  return join(stateRoot, "controls", `draft-apply-plan-${physicalSessionId}.json`);
}

async function readManualBranchControl(stateRoot: string): Promise<ManualBranchControlFile> {
  const path = controlsPath(stateRoot);
  if (!existsSync(path)) {
    return {
      updatedAt: "",
      bindings: {},
      plannedBranches: [],
    };
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ManualBranchControlFile>;
    return {
      updatedAt: asString(parsed.updatedAt, ""),
      bindings:
        parsed.bindings && typeof parsed.bindings === "object"
          ? (parsed.bindings as Record<string, ManualBranchBinding>)
          : {},
      plannedBranches: Array.isArray(parsed.plannedBranches)
        ? (parsed.plannedBranches as ManualPlannedBranch[])
        : [],
    };
  } catch {
    return {
      updatedAt: "",
      bindings: {},
      plannedBranches: [],
    };
  }
}

async function writeManualBranchControl(stateRoot: string, control: ManualBranchControlFile): Promise<void> {
  const path = controlsPath(stateRoot);
  await mkdir(join(stateRoot, "controls"), { recursive: true });
  await writeFile(path, JSON.stringify(control, null, 2), "utf8");
}

async function writeDraftApplyPlan(
  stateRoot: string,
  physicalSessionId: string,
  plan: DraftApplyPlan,
): Promise<string> {
  const path = draftApplyPlanPath(stateRoot, physicalSessionId);
  await mkdir(join(stateRoot, "controls"), { recursive: true });
  await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
  return path;
}

function clonedWithSessionId<T>(value: T, fromSessionId: string, toSessionId: string): T {
  const cloned = JSON.parse(JSON.stringify(value)) as T;
  if (!cloned || typeof cloned !== "object") return cloned;
  const root = cloned as Record<string, unknown>;
  if (root.sessionId === fromSessionId) root.sessionId = toSessionId;
  const trace = asRecord(root.trace);
  if (trace) {
    const initialContext = asRecord(trace.initialContext);
    const finalContext = asRecord(trace.finalContext);
    if (initialContext?.sessionId === fromSessionId) initialContext.sessionId = toSessionId;
    if (finalContext?.sessionId === fromSessionId) finalContext.sessionId = toSessionId;
  }
  return cloned;
}

async function writeSessionSnapshot(
  stateRoot: string,
  sessionId: string,
  rows: unknown[],
  meta: UnknownRecord,
): Promise<void> {
  const sessionDir = join(stateRoot, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const turnsText = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(join(sessionDir, "turns.jsonl"), turnsText ? `${turnsText}\n` : "", "utf8");
  await writeFile(join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

async function appendSessionRows(
  stateRoot: string,
  sessionId: string,
  appendedRows: unknown[],
): Promise<number> {
  const sessionDir = join(stateRoot, "sessions", sessionId);
  const turnsPath = join(sessionDir, "turns.jsonl");
  const metaPath = join(sessionDir, "meta.json");
  const existingRows = await readSessionTurns(turnsPath);
  const nextRows = [...existingRows, ...appendedRows];
  const existingMeta = existsSync(metaPath)
    ? ((JSON.parse(await readFile(metaPath, "utf8")) as UnknownRecord) ?? {})
    : {};
  const latestRecord = asRecord(nextRows[nextRows.length - 1]);
  const updatedAt = asString(latestRecord?.endedAt || latestRecord?.startedAt, new Date().toISOString());
  await writeSessionSnapshot(stateRoot, sessionId, nextRows, {
    ...existingMeta,
    sessionId,
    updatedAt,
    turnCount: nextRows.length,
  });
  return nextRows.length;
}

function buildSyntheticToolSegment(block: DashboardDraftBlockInput, turnId: string): ContextSegment {
  return {
    id: `${turnId}:tool`,
    kind: "volatile",
    text: asString(block.text, ""),
    priority: 20,
    source: "draft.materialized.tool",
    metadata: {
      isToolPayload: true,
      payloadKind: asString(block.source, "").includes("json") ? "json" : "tool",
      toolPayload: {
        enabled: true,
        toolName: asString(block.title, "Tool"),
        kind: "tool",
      },
    },
  };
}

function buildMaterializedTurnRow(
  block: DashboardDraftBlockInput,
  sessionId: string,
  provider: string,
  model: string,
  apiFamily: string,
  turnIndex: number,
  at: string,
): UnknownRecord {
  const turnId = randomUUID();
  const role = normalizeForwardedRole(asString(block.role, "user"));
  const text = asString(block.text, "");
  const traceSegments: ContextSegment[] =
    role === "tool"
      ? [buildSyntheticToolSegment(block, turnId)]
      : role === "system"
        ? [{
            id: `${turnId}:system-seed`,
            kind: "stable",
            text,
            priority: 1,
            source: "draft.materialized.system",
          }]
        : [];

  return {
    turnId,
    sessionId,
    provider,
    model,
    apiFamily,
    startedAt: at,
    endedAt: at,
    status: "draft_materialized",
    prompt: role === "user" ? text : "",
    response: role === "assistant" ? text : "",
    responsePreview: role === "assistant" ? text : "",
    segments: traceSegments,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      providerRaw: {
        input: 0,
        output: 0,
        cacheRead: 0,
      },
    },
    resultMetadata: {
      synthetic: true,
      source: "lab-bench",
      materializedRole: role,
      title: asString(block.title, "Message"),
      turnIndex,
    },
    trace: {
      responsePreview: role === "assistant" ? text : "",
      initialContext: {
        sessionId,
        prompt: role === "user" ? text : "",
        segments: traceSegments,
      },
      finalContext: {
        sessionId,
        prompt: role === "user" ? text : "",
        segments: traceSegments,
      },
      moduleSteps: [],
      usageNormalized: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      },
      usageRaw: {
        input: 0,
        output: 0,
        cacheRead: 0,
      },
      requestDetail: {
        source: "draft.apply.materialized",
        role,
        title: asString(block.title, "Message"),
      },
    },
  };
}

function isDraftMaterializedTrace(entry: RawTraceEntry): boolean {
  const eventTypes = Array.isArray(entry.eventTypes) ? entry.eventTypes.map((item) => String(item)) : [];
  if (eventTypes.includes("draft.apply.materialized")) return true;
  return asString(entry.prompt, "").startsWith("[draft materialized]");
}

function annotateSegments(
  segments: ContextSegment[],
  stableChars: number,
  phase: "initial" | "final",
  initialSegments: ContextSegment[],
  finalSegments: ContextSegment[],
): DashboardSegmentView[] {
  let cursor = 0;
  const changes = segmentChangeMap(initialSegments, finalSegments);
  return segments.map((segment) => {
    const nextCursor = cursor + segment.text.length;
    let prefixZone: DashboardSegmentView["prefixZone"] = "tail";
    if (stableChars > 0 && nextCursor <= stableChars) prefixZone = "stable_prefix";
    else if (stableChars > 0 && cursor < stableChars && nextCursor > stableChars) prefixZone = "prefix_edge";
    cursor = nextCursor;
    const metadata = asRecord(segment.metadata);
    const toolPayload = asRecord(metadata?.toolPayload);
    const reduction = asRecord(metadata?.reduction);
    return {
      id: segment.id,
      kind: segment.kind,
      source: segment.source,
      priority: segment.priority,
      text: segment.text,
      chars: segment.text.length,
      prefixZone,
      changeType: phase === "initial" ? changes.initialChangeType(segment) : changes.finalChangeType(segment),
      isToolPayload: Boolean(metadata?.isToolPayload || toolPayload?.enabled || reduction?.target === "tool_payload"),
      payloadKind: asString(metadata?.payloadKind || toolPayload?.kind || reduction?.payloadKind, ""),
    };
  });
}

function discoverStateRoots(): string[] {
  const configured = process.env.ECOCLAW_STATE_ROOTS
    ?.split(":")
    .map((item) => item.trim())
    .filter(Boolean);
  const roots = configured && configured.length > 0 ? configured : DEFAULT_STATE_ROOTS;
  return roots.filter((root, index) => roots.indexOf(root) === index && existsSync(root));
}

async function loadIndexedTraces(): Promise<IndexedTrace[]> {
  const roots = discoverStateRoots();
  const traces: IndexedTrace[] = [];
  for (const root of roots) {
    const tracePath = join(root, "event-trace.jsonl");
    const rows = await readJsonlFile(tracePath, MAX_TRACE_LINES);
    for (const row of rows) {
      const entry = row as RawTraceEntry;
      if (!entry || typeof entry !== "object") continue;
      traces.push({ traceId: traceIdOf(entry, root), stateRoot: root, entry });
    }
  }
  traces.sort((a, b) => asString(b.entry.at).localeCompare(asString(a.entry.at)));
  return traces;
}

async function loadProviderTraffic(stateRoot: string): Promise<UnknownRecord[]> {
  const providerPath = join(stateRoot, "provider-traffic.jsonl");
  const rows = await readJsonlFile(providerPath, MAX_PROVIDER_LINES);
  return rows.filter((row): row is UnknownRecord => Boolean(asRecord(row)));
}

function nearestProviderEntries(entries: UnknownRecord[], at: string): DashboardProviderEntry[] {
  const target = Date.parse(at);
  if (!Number.isFinite(target)) return [];
  return entries
    .map((entry) => {
      const entryAt = Date.parse(asString(entry.at));
      const deltaMs = Number.isFinite(entryAt) ? Math.abs(entryAt - target) : Number.MAX_SAFE_INTEGER;
      const requestBody = asString(entry.requestBody, "");
      const responseBody = asString(entry.responseBody, "");
      const requestBodyPreview = requestBody ? requestBody.slice(0, 2400) : undefined;
      const responseBodyPreview = responseBody ? responseBody.slice(0, 2400) : undefined;
      const requestJson = requestBody ? asRecord(safeJsonParse(requestBody)) : undefined;
      const responseJson = responseBody ? extractResponseEnvelope(responseBody) : undefined;
      const responseText =
        asString(entry.responseText) || (responseBody ? extractResponseText(responseBody, responseJson) : "");
      return {
        at: asString(entry.at),
        deltaMs,
        stage: asString(entry.stage, undefined as unknown as string),
        method: asString(entry.method, undefined as unknown as string),
        status: typeof entry.status === "number" ? entry.status : undefined,
        url: asString(entry.url, undefined as unknown as string),
        promptCacheRetention:
          asString(requestJson?.prompt_cache_retention) ||
          asString(asRecord(responseJson?.response)?.prompt_cache_retention) ||
          null,
        requestBodyPreview,
        responseBodyPreview,
        responseText: responseText || undefined,
        promptCacheKey:
          asString(requestJson?.prompt_cache_key) || asString(asRecord(responseJson?.response)?.prompt_cache_key) || null,
        requestBody: requestBody || undefined,
        responseBody: entry.responseBody,
        requestJson,
        responseJson,
        payload: entry.payload,
      } satisfies DashboardProviderEntry;
    })
    .filter((entry) => entry.deltaMs <= PROVIDER_MATCH_WINDOW_MS)
    .sort((a, b) => a.deltaMs - b.deltaMs)
    .slice(0, 6);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractResponseEnvelope(responseBody: string): UnknownRecord | undefined {
  const lines = responseBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = safeJsonParse(line.slice(5).trim());
    const record = asRecord(payload);
    if (record?.type === "response.created") return record;
  }
  return undefined;
}

function extractResponseTextFromNode(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => extractResponseTextFromNode(item))
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  if (!record) return "";
  const type = asString(record.type).toLowerCase();
  const role = asString(record.role).toLowerCase();
  if (type === "output_text" && typeof record.text === "string") return record.text;
  if (typeof record.delta === "string" && record.delta.trim()) return String(record.delta);
  if (type === "message" || role === "assistant") {
    return extractResponseTextFromNode(record.content ?? record.output ?? record.text);
  }
  return extractResponseTextFromNode(
    record.response ?? record.output ?? record.item ?? record.content ?? record.text ?? record.message,
  );
}

function extractResponseText(responseBody: string, responseJson?: UnknownRecord): string {
  const fromEnvelope = extractResponseTextFromNode(responseJson?.response ?? responseJson);
  if (fromEnvelope.trim()) return fromEnvelope.trim();

  let deltaText = "";
  const lines = responseBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = safeJsonParse(line.slice(5).trim());
    const record = asRecord(payload);
    if (!record) continue;
    if (asString(record.type) === "response.created") continue;
    const fromRecord = extractResponseTextFromNode(record.response ?? record.item ?? record.output ?? record);
    if (fromRecord.trim()) return fromRecord.trim();
    if (typeof record.delta === "string") deltaText += String(record.delta);
  }
  return deltaText.trim();
}

export async function loadOverview(): Promise<DashboardOverview> {
  const traces = await loadIndexedTraces();
  const sessionMap = new Map<string, DashboardSessionSummary>();
  const recentTurns: DashboardTurnSummary[] = [];

  for (const trace of traces) {
    if (isManualBranchScaffold(trace.entry)) continue;
    const sessionId = asString(trace.entry.logicalSessionId || trace.entry.physicalSessionId, "unknown");
    const usage = usageOf(trace.entry.usage);
    const turnSummary: DashboardTurnSummary = {
      traceId: trace.traceId,
      sessionId,
      physicalSessionId: asString(trace.entry.physicalSessionId, ""),
      at: asString(trace.entry.at),
      provider: asString(trace.entry.provider, "unknown"),
      model: asString(trace.entry.model, "unknown"),
      apiFamily: asString(trace.entry.apiFamily, "unknown"),
      promptPreview: previewOf(asString(trace.entry.prompt, ""), 90),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      eventTypes: Array.isArray(trace.entry.eventTypes) ? trace.entry.eventTypes.map((item) => String(item)) : [],
      stateRoot: trace.stateRoot,
    };
    recentTurns.push(turnSummary);

    const current = sessionMap.get(sessionId);
    if (!current) {
      sessionMap.set(sessionId, {
        id: sessionId,
        stateRoot: trace.stateRoot,
        turnCount: 1,
        lastAt: turnSummary.at,
        provider: turnSummary.provider,
        model: turnSummary.model,
        apiFamily: turnSummary.apiFamily,
        cacheReadTokens: turnSummary.cacheReadTokens,
        inputTokens: turnSummary.inputTokens,
        outputTokens: turnSummary.outputTokens,
        latestTraceId: turnSummary.traceId,
      });
    } else {
      current.turnCount += 1;
      if (turnSummary.at > current.lastAt) {
        current.lastAt = turnSummary.at;
        current.provider = turnSummary.provider;
        current.model = turnSummary.model;
        current.apiFamily = turnSummary.apiFamily;
        current.cacheReadTokens = turnSummary.cacheReadTokens;
        current.inputTokens = turnSummary.inputTokens;
        current.outputTokens = turnSummary.outputTokens;
        current.latestTraceId = turnSummary.traceId;
        current.stateRoot = turnSummary.stateRoot;
      }
    }
  }

  const sessions = Array.from(sessionMap.values()).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const stateRoots = discoverStateRoots();
  return {
    stateRoots,
    selectedStateRoot: stateRoots[0] ?? "",
    sessions,
    recentTurns: recentTurns.slice(0, 40),
  };
}

export async function loadSessionTurns(sessionId: string): Promise<DashboardTurnSummary[]> {
  const traces = await loadIndexedTraces();
  return traces
    .filter(
      (trace) =>
        asString(trace.entry.logicalSessionId || trace.entry.physicalSessionId, "unknown") === sessionId &&
        !isManualBranchScaffold(trace.entry),
    )
    .map((trace) => {
      const usage = usageOf(trace.entry.usage);
      return {
        traceId: trace.traceId,
        sessionId,
        physicalSessionId: asString(trace.entry.physicalSessionId, ""),
        at: asString(trace.entry.at),
        provider: asString(trace.entry.provider, "unknown"),
        model: asString(trace.entry.model, "unknown"),
        apiFamily: asString(trace.entry.apiFamily, "unknown"),
        promptPreview: previewOf(asString(trace.entry.prompt, ""), 90),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        eventTypes: Array.isArray(trace.entry.eventTypes) ? trace.entry.eventTypes.map((item) => String(item)) : [],
        stateRoot: trace.stateRoot,
      } satisfies DashboardTurnSummary;
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export async function loadTurnDetail(traceId: string): Promise<DashboardTurnDetail | null> {
  const traces = await loadIndexedTraces();
  const trace = traces.find((item) => item.traceId === traceId);
  if (!trace) return null;
  const scaffoldTrace = isManualBranchScaffold(trace.entry);
  const syntheticTrace = isDraftMaterializedTrace(trace.entry);
  const sessionId = asString(trace.entry.logicalSessionId || trace.entry.physicalSessionId, "unknown");
  const physicalSessionId = asString(trace.entry.physicalSessionId, sessionId);

  const contextDetail = asRecord(trace.entry.contextDetail);
  const initialContext = asRecord(trace.entry.initialContext) ?? asRecord(contextDetail?.initialContext);
  const finalContext = asRecord(trace.entry.finalContext) ?? asRecord(contextDetail?.finalContext);
  const initialSegments = Array.isArray(initialContext?.segments) ? (initialContext?.segments as ContextSegment[]) : [];
  const finalSegments = Array.isArray(finalContext?.segments) ? (finalContext?.segments as ContextSegment[]) : [];
  const finalMetadata = asRecord(finalContext?.metadata);
  const stabilizer = asRecord(finalMetadata?.stabilizer);
  const reduction = asRecord(finalMetadata?.reduction);
  const policy = asRecord(finalMetadata?.policy);
  const resultEvents = Array.isArray(trace.entry.resultEvents) ? trace.entry.resultEvents : [];
  const summaryPayload = latestEventPayload(resultEvents, "summary.generated");
  const compactionPlanPayload = latestEventPayload(resultEvents, "compaction.plan.generated");
  const compactionApplyPayload = latestEventPayload(resultEvents, "compaction.apply.executed");
  const usage = usageOf(trace.entry.usage);
  const providerTraffic = scaffoldTrace || syntheticTrace
    ? []
    : nearestProviderEntries(await loadProviderTraffic(trace.stateRoot), asString(trace.entry.at));
  const forwardedEntry = pickForwardedPayloadEntry(providerTraffic);
  const stableChars = asNumber(stabilizer?.prefixChars);
  const conversation = await loadConversationBlocks(
    {
      logicalSessionId: asString(trace.entry.logicalSessionId || trace.entry.physicalSessionId, "unknown"),
      physicalSessionId: asString(trace.entry.physicalSessionId, ""),
      targetAt: asString(trace.entry.at),
      targetPrompt: asString(trace.entry.prompt, ""),
    },
    trace.stateRoot,
  );
  const targetTurnId = conversation.filter((block) => block.role !== "system").slice(-1)[0]?.turnId ?? "turn-current";
  const targetTurnIndex = conversation.filter((block) => block.role !== "system").slice(-1)[0]?.turnIndex ?? 1;
  const forwardedPayload = asRecord(forwardedEntry?.payload) ?? asRecord(forwardedEntry?.requestJson);
  const forwardedResponseText =
    asString(trace.entry.responsePreview, "").trim() ||
    providerTraffic.map((entry) => asString(entry.responseText).trim()).find(Boolean) ||
    "";
  const forwardedResponseSource = asString(trace.entry.responsePreview, "").trim()
    ? "trace.responsePreview"
    : providerTraffic.some((entry) => asString(entry.responseText).trim())
      ? "provider.response"
      : undefined;
  const actualForwardedBlocks = scaffoldTrace || syntheticTrace
    ? []
    : buildForwardedBlocksFromPayload(
      forwardedPayload,
      targetTurnId,
      targetTurnIndex,
      asString(trace.entry.at),
      forwardedResponseText,
      forwardedResponseSource,
    );
  const replayConversationFromTrace = Array.isArray(contextDetail?.forwardedConversation)
    ? (contextDetail?.forwardedConversation as DashboardConversationBlock[])
    : [];
  const replayConversation =
    scaffoldTrace || syntheticTrace
      ? replayConversationFromTrace
      : actualForwardedBlocks.length > 0
        ? actualForwardedBlocks
        : replayConversationFromTrace;
  const turnTree = await buildTurnTree(traces, trace.stateRoot, sessionId, traceId);
  return {
    traceId,
    sessionId,
    physicalSessionId,
    at: asString(trace.entry.at),
    provider: asString(trace.entry.provider, "unknown"),
    model: asString(trace.entry.model, "unknown"),
    apiFamily: asString(trace.entry.apiFamily, "unknown"),
    prompt: asString(trace.entry.prompt, ""),
    promptPreview: previewOf(asString(trace.entry.prompt, ""), 180),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      netTokens: usage.cacheReadTokens - usage.inputTokens - usage.outputTokens,
      cacheHitRate: usage.cacheHitRate,
    },
    prefix: {
      stableChars,
      stableSignature: asString(stabilizer?.prefixSignature, ""),
      normalizedSignature: asString(stabilizer?.prefixSignatureNormalized, ""),
    },
    initialSegments: annotateSegments(initialSegments, stableChars, "initial", initialSegments, finalSegments),
    finalSegments: annotateSegments(finalSegments, stableChars, "final", initialSegments, finalSegments),
    moduleSteps: Array.isArray(trace.entry.moduleSteps)
      ? trace.entry.moduleSteps
      : Array.isArray(contextDetail?.moduleSteps)
        ? (contextDetail.moduleSteps as unknown[])
        : [],
    eventTypes: Array.isArray(trace.entry.eventTypes) ? trace.entry.eventTypes.map((item) => String(item)) : [],
    finalContextEvents: Array.isArray(trace.entry.finalContextEvents) ? trace.entry.finalContextEvents : [],
    resultEvents,
    policy,
    reduction,
    summary: asRecord(summaryPayload?.artifact),
    compaction: asRecord(compactionApplyPayload?.appliedPlan) ?? asRecord(compactionPlanPayload?.plan),
    requestDetail: asRecord(contextDetail?.requestDetail) ?? contextDetail,
    openclawPromptRoot: asString(contextDetail?.openclawPromptRoot, ""),
    responsePreview: asString(trace.entry.responsePreview, ""),
    providerTraffic,
    stateRoot: trace.stateRoot,
    conversation,
    actualForwardedConversation: actualForwardedBlocks,
    replayConversation,
    turnTree,
  };
}

export async function createManualBranchAction(
  traceId: string,
  action: ManualBranchAction,
): Promise<DashboardBranchActionResult> {
  const traces = await loadIndexedTraces();
  const trace = traces.find((item) => item.traceId === traceId);
  if (!trace) {
    throw new Error(`Trace not found: ${traceId}`);
  }

  const logicalSessionId = asString(trace.entry.logicalSessionId || trace.entry.physicalSessionId, "unknown");
  const sourcePhysicalSessionId = asString(trace.entry.physicalSessionId || logicalSessionId, logicalSessionId);
  const sourceDetail = await loadTurnDetail(traceId);
  const turnsPath = conversationTurnsPath(trace.stateRoot, {
    logicalSessionId,
    physicalSessionId: sourcePhysicalSessionId,
    targetAt: asString(trace.entry.at),
    targetPrompt: asString(trace.entry.prompt, ""),
  });
  const rows = await readSessionTurns(turnsPath);
  if (!rows.length) {
    throw new Error(`No session transcript found for ${sourcePhysicalSessionId}`);
  }

  const cutoffIndex = targetConversationIndex(rows, {
    logicalSessionId,
    physicalSessionId: sourcePhysicalSessionId,
    targetAt: asString(trace.entry.at),
    targetPrompt: asString(trace.entry.prompt, ""),
  });
  if (cutoffIndex < 0) {
    throw new Error(`Could not locate target turn for ${traceId}`);
  }

  const control = await readManualBranchControl(trace.stateRoot);
  const branchCount = control.plannedBranches.filter((item) => item.logicalSessionId === logicalSessionId).length + 1;
  const suffix = `${action === "fork" ? "mf" : "rv"}${branchCount.toString().padStart(4, "0")}`;
  const newPhysicalSessionId = `${safeBranchId(logicalSessionId)}-${suffix}`;
  const copiedRows = rows
    .slice(0, cutoffIndex + 1)
    .map((row) => clonedWithSessionId(row, sourcePhysicalSessionId, newPhysicalSessionId));

  const sourceMetaPath = join(trace.stateRoot, "sessions", sourcePhysicalSessionId, "meta.json");
  const sourceMeta = existsSync(sourceMetaPath)
    ? ((JSON.parse(await readFile(sourceMetaPath, "utf8")) as UnknownRecord) ?? {})
    : {};
  const updatedAt =
    asString(asRecord(copiedRows[copiedRows.length - 1])?.endedAt) ||
    asString(trace.entry.at) ||
    new Date().toISOString();
  await writeSessionSnapshot(trace.stateRoot, newPhysicalSessionId, copiedRows, {
    sessionId: newPhysicalSessionId,
    createdAt: new Date().toISOString(),
    updatedAt,
    provider: asString(sourceMeta.provider || trace.entry.provider),
    model: asString(sourceMeta.model || trace.entry.model),
    apiFamily: asString(sourceMeta.apiFamily || trace.entry.apiFamily),
    lastStatus: asString(sourceMeta.lastStatus, "ok"),
    turnCount: copiedRows.length,
    manualBranch: {
      logicalSessionId,
      sourcePhysicalSessionId,
      sourceTraceId: traceId,
      action,
    },
  });

  const plannedBranch: ManualPlannedBranch = {
    logicalSessionId,
    physicalSessionId: newPhysicalSessionId,
    parentPhysicalSessionId: sourcePhysicalSessionId,
    sourceTraceId: traceId,
    action,
    createdAt: new Date().toISOString(),
  };
  control.updatedAt = plannedBranch.createdAt;
  control.bindings[logicalSessionId] = {
    physicalSessionId: newPhysicalSessionId,
    sourceTraceId: traceId,
    sourcePhysicalSessionId,
    action,
    updatedAt: plannedBranch.createdAt,
  };
  control.plannedBranches = [
    ...control.plannedBranches.filter((item) => item.physicalSessionId !== newPhysicalSessionId),
    plannedBranch,
  ];
  await writeManualBranchControl(trace.stateRoot, control);

  await appendFile(
    join(trace.stateRoot, "event-trace.jsonl"),
    `${JSON.stringify({
      at: plannedBranch.createdAt,
      logicalSessionId,
      physicalSessionId: newPhysicalSessionId,
      branch: {
        logicalSessionId,
        physicalSessionId: newPhysicalSessionId,
        forkedFromSessionId: sourcePhysicalSessionId,
        branchStrategy: action,
        sourceTraceId: traceId,
      },
      provider: trace.entry.provider,
      model: trace.entry.model,
      apiFamily: trace.entry.apiFamily,
      prompt: `[manual ${action}] branch created from ${sourcePhysicalSessionId}`,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      },
      contextDetail: {
        forwardedConversation: sourceDetail?.replayConversation ?? [],
        branchSeed: {
          action,
          sourceTraceId: traceId,
          sourcePhysicalSessionId,
        },
      },
      responsePreview: "",
      eventTypes: ["manual.branch.created"],
      resultEvents: [
        {
          type: "manual.branch.created",
          source: "lab-bench",
          at: plannedBranch.createdAt,
          payload: {
            action,
            logicalSessionId,
            physicalSessionId: newPhysicalSessionId,
            parentPhysicalSessionId: sourcePhysicalSessionId,
            sourceTraceId: traceId,
          },
        },
      ],
    })}\n`,
    "utf8",
  );

  const refreshed = await loadSessionTurns(logicalSessionId);
  const createdTraceId =
    refreshed.find((item) => item.physicalSessionId === newPhysicalSessionId)?.traceId ?? traceId;

  return {
    ok: true,
    action,
    sessionId: logicalSessionId,
    physicalSessionId: newPhysicalSessionId,
    traceId: createdTraceId,
    sourceTraceId: traceId,
  };
}

async function resolveTraceIdForTurn(
  logicalSessionId: string,
  physicalSessionId: string,
  turnId: string,
): Promise<string | null> {
  const traces = await loadIndexedTraces();
  const candidates = traces.filter((trace) => {
    const entryLogical = asString(trace.entry.logicalSessionId || trace.entry.physicalSessionId, "unknown");
    const entryPhysical = asString(trace.entry.physicalSessionId || entryLogical, entryLogical);
    return entryLogical === logicalSessionId && entryPhysical === physicalSessionId;
  });
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    const detail = await loadTurnDetail(candidate.traceId);
    const blocks = detail?.replayConversation ?? [];
    if (blocks.some((block) => block.turnId === turnId)) {
      return candidate.traceId;
    }
  }
  return null;
}

export async function applyDraftPlan(
  traceId: string,
  draftBlocksInput: DashboardDraftBlockInput[],
): Promise<DashboardDraftApplyResult> {
  const sourceDetail = await loadTurnDetail(traceId);
  if (!sourceDetail) {
    throw new Error(`turn not found: ${traceId}`);
  }

  const sourceBlocks = sourceDetail.replayConversation ?? [];
  const draftBlocks = draftBlocksInput.map((block) => normalizeDraftBlockInput(block)).filter((block) => block.text);
  if (!sourceBlocks.length) {
    throw new Error("no forwarded conversation available for this turn");
  }
  if (!draftBlocks.length) {
    throw new Error("draft blocks are empty");
  }

  const divergence = computeDraftDivergenceStats(sourceBlocks, draftBlocks);
  if (divergence.divergenceIndex < 0) {
    throw new Error("draft matches source; nothing to apply");
  }

  const divergenceIndex = divergence.divergenceIndex;
  const divergentDraftBlocks = draftBlocks.slice(divergenceIndex);
  const cacheChars = divergence.cacheChars;
  const newChars = divergence.newChars;

  const lastSharedSourceBlock = sourceBlocks[Math.max(0, divergenceIndex - 1)];
  const anchorTraceId =
    lastSharedSourceBlock?.turnId
      ? await resolveTraceIdForTurn(sourceDetail.sessionId, sourceDetail.physicalSessionId ?? sourceDetail.sessionId, lastSharedSourceBlock.turnId)
      : null;
  const effectiveAnchorTraceId = anchorTraceId ?? traceId;

  const branchResult = await createManualBranchAction(effectiveAnchorTraceId, "fork");

  const seedBlocks = divergentDraftBlocks.filter((block) => normalizeForwardedRole(asString(block.role, "user")) !== "user");
  const userTurns = divergentDraftBlocks
    .filter((block) => normalizeForwardedRole(asString(block.role, "user")) === "user")
    .map((block) => ({
      role: "user" as const,
      title: asString(block.title, "User"),
      text: asString(block.text, "").trim(),
      sourceRefs: Array.isArray(block.sourceRefs) ? block.sourceRefs : [],
    }))
    .filter((block) => block.text);

  const seedText = buildDraftSeedText(seedBlocks);
  const plan: DraftApplyPlan = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    logicalSessionId: sourceDetail.sessionId,
    sourceTraceId: traceId,
    anchorTraceId: effectiveAnchorTraceId,
    sourcePhysicalSessionId: sourceDetail.physicalSessionId ?? sourceDetail.sessionId,
    targetPhysicalSessionId: branchResult.physicalSessionId,
    divergenceIndex,
    cacheChars,
    newChars,
    seedBlocks: seedBlocks.map((block) => ({
      role: normalizeForwardedRole(asString(block.role, "user")),
      title: asString(block.title, "Message"),
      text: asString(block.text, ""),
      sourceRefs: Array.isArray(block.sourceRefs) ? block.sourceRefs : [],
    })),
    seedText,
    userTurns,
    draftBlocks,
  };

  const planPath = await writeDraftApplyPlan(sourceDetail.stateRoot, branchResult.physicalSessionId, plan);

  const branchTurnsPath = conversationTurnsPath(sourceDetail.stateRoot, {
    logicalSessionId: sourceDetail.sessionId,
    physicalSessionId: branchResult.physicalSessionId,
  });
  const branchRows = await readSessionTurns(branchTurnsPath);
  const nextTurnIndexBase = branchRows.length;
  const materializedAtBase = Date.now();
  const materializedTraceIds: string[] = [];
  const materializedRows: UnknownRecord[] = [];
  const materializedEvents: string[] = [];
  let previousTraceId = effectiveAnchorTraceId;

  for (let index = 0; index < divergentDraftBlocks.length; index += 1) {
    const block = divergentDraftBlocks[index];
    const at = new Date(materializedAtBase + index).toISOString();
    const turnIndex = nextTurnIndexBase + index + 1;
    const syntheticRow = buildMaterializedTurnRow(
      block,
      branchResult.physicalSessionId,
      sourceDetail.provider,
      sourceDetail.model,
      sourceDetail.apiFamily,
      turnIndex,
      at,
    );
    materializedRows.push(syntheticRow);

    const cumulativeForwardedConversation = [
      ...draftBlocks.slice(0, divergenceIndex + index + 1).map((draftBlock, draftIndex) => ({
        id: asString(draftBlock.draftId, `draft-forwarded-${draftIndex + 1}`),
        turnId: asString(asRecord(syntheticRow)?.turnId, `draft-turn-${draftIndex + 1}`),
        turnIndex: draftIndex + 1,
        at,
        role: normalizeForwardedRole(asString(draftBlock.role, "user")),
        title: asString(draftBlock.title, "Message"),
        text: asString(draftBlock.text, ""),
        chars: asString(draftBlock.text, "").length,
        source: asString(draftBlock.source, "draft.materialized"),
      } satisfies DashboardConversationBlock)),
    ];

    const eventEntry = {
      at,
      logicalSessionId: sourceDetail.sessionId,
      physicalSessionId: branchResult.physicalSessionId,
      branch: {
        logicalSessionId: sourceDetail.sessionId,
        physicalSessionId: branchResult.physicalSessionId,
        forkedFromSessionId: sourceDetail.physicalSessionId ?? sourceDetail.sessionId,
        branchStrategy: "draft_apply_materialized",
        sourceTraceId: previousTraceId,
      },
      provider: sourceDetail.provider,
      model: sourceDetail.model,
      apiFamily: sourceDetail.apiFamily,
      prompt: `[draft materialized] ${asString(block.title, "Message")}`,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      },
      contextDetail: {
        forwardedConversation: cumulativeForwardedConversation,
        branchSeed: {
          sourceTraceId: traceId,
          anchorTraceId: effectiveAnchorTraceId,
          divergenceIndex,
          cacheChars,
          newChars,
          materializedIndex: index,
          materializedRole: normalizeForwardedRole(asString(block.role, "user")),
          materializedTitle: asString(block.title, "Message"),
          planPath,
        },
      },
      responsePreview:
        normalizeForwardedRole(asString(block.role, "user")) === "assistant"
          ? asString(block.text, "")
          : "",
      eventTypes: ["draft.apply.materialized"],
      resultEvents: [
        {
          type: "draft.apply.materialized",
          source: "lab-bench",
          at,
          payload: {
            sourceTraceId: traceId,
            anchorTraceId: effectiveAnchorTraceId,
            targetPhysicalSessionId: branchResult.physicalSessionId,
            materializedIndex: index,
            materializedRole: normalizeForwardedRole(asString(block.role, "user")),
            materializedTitle: asString(block.title, "Message"),
            planPath,
          },
        },
      ],
    };
    const materializedTraceId = traceIdOf(eventEntry, sourceDetail.stateRoot);
    materializedTraceIds.push(materializedTraceId);
    materializedEvents.push(`${JSON.stringify(eventEntry)}\n`);
    previousTraceId = materializedTraceId;
  }

  if (materializedRows.length > 0) {
    await appendSessionRows(sourceDetail.stateRoot, branchResult.physicalSessionId, materializedRows);
    await appendFile(
      join(sourceDetail.stateRoot, "event-trace.jsonl"),
      materializedEvents.join(""),
      "utf8",
    );
  }

  await appendFile(
    join(sourceDetail.stateRoot, "event-trace.jsonl"),
    `${JSON.stringify({
      at: plan.createdAt,
      logicalSessionId: sourceDetail.sessionId,
      physicalSessionId: branchResult.physicalSessionId,
      branch: {
        logicalSessionId: sourceDetail.sessionId,
        physicalSessionId: branchResult.physicalSessionId,
        forkedFromSessionId: sourceDetail.physicalSessionId ?? sourceDetail.sessionId,
        branchStrategy: "draft_apply_plan",
        sourceTraceId: effectiveAnchorTraceId,
      },
      provider: sourceDetail.provider,
      model: sourceDetail.model,
      apiFamily: sourceDetail.apiFamily,
      prompt: `[draft apply] planned from ${effectiveAnchorTraceId}`,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      },
      contextDetail: {
        branchSeed: {
          sourceTraceId: traceId,
          anchorTraceId: effectiveAnchorTraceId,
          divergenceIndex,
          cacheChars,
          newChars,
          seedBlockCount: plan.seedBlocks.length,
          userTurnCount: plan.userTurns.length,
          planPath,
        },
      },
      responsePreview: "",
      eventTypes: ["draft.apply.planned"],
      resultEvents: [
        {
          type: "draft.apply.planned",
          source: "lab-bench",
          at: plan.createdAt,
          payload: {
            sourceTraceId: traceId,
            anchorTraceId: effectiveAnchorTraceId,
            targetPhysicalSessionId: branchResult.physicalSessionId,
            divergenceIndex,
            cacheChars,
            newChars,
            seedBlockCount: plan.seedBlocks.length,
            userTurnCount: plan.userTurns.length,
            planPath,
          },
        },
      ],
    })}\n`,
    "utf8",
  );

  return {
    ok: true,
    sessionId: sourceDetail.sessionId,
    physicalSessionId: branchResult.physicalSessionId,
    traceId: materializedTraceIds[materializedTraceIds.length - 1] ?? branchResult.traceId,
    sourceTraceId: traceId,
    anchorTraceId: effectiveAnchorTraceId,
    divergenceIndex,
    cacheChars,
    newChars,
    seedBlockCount: plan.seedBlocks.length,
    userTurnCount: plan.userTurns.length,
    seedTextPreview: previewOf(seedText, 220),
    planPath,
    materializedTurnCount: materializedTraceIds.length,
    materializedTraceIds,
  };
}
