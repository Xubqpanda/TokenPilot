/* eslint-disable @typescript-eslint/no-explicit-any */
import { createDecisionLedgerModule, createPolicyModule } from "@ecoclaw/layer-decision";
import { createContextStateModule } from "@ecoclaw/layer-context";
import {
  createStabilizerModule,
  createReductionModule,
  createSummaryModule,
  createCompactionModule,
  createHandoffModule,
} from "@ecoclaw/layer-execution";
import { createOpenClawConnector } from "@ecoclaw/layer-orchestration";
import { anthropicAdapter } from "@ecoclaw/provider-anthropic";
import { openaiAdapter } from "@ecoclaw/provider-openai";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { readFile, mkdir, appendFile, writeFile } from "node:fs/promises";
import { ECOCLAW_EVENT_TYPES, type RuntimeTurnContext, type RuntimeTurnResult } from "@ecoclaw/kernel";

type EcoClawPluginConfig = {
  enabled?: boolean;
  logLevel?: "info" | "debug";
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  stateDir?: string;
  debugTapProviderTraffic?: boolean;
  debugTapPath?: string;
  proxyAutostart?: boolean;
  proxyPort?: number;
  compaction?: {
    enabled?: boolean;
    autoForkOnPolicy?: boolean;
    summaryGenerationMode?: "llm_full_context" | "heuristic";
    summaryFallbackToHeuristic?: boolean;
    summaryMaxOutputTokens?: number;
    includeAssistantReply?: boolean;
    summaryPrompt?: string;
    summaryPromptPath?: string;
    resumePrefixPrompt?: string;
    resumePrefixPromptPath?: string;
    compactionCooldownTurns?: number;
  };
  handoff?: {
    enabled?: boolean;
    handoffGenerationMode?: "llm_full_context" | "heuristic";
    handoffFallbackToHeuristic?: boolean;
    handoffMaxOutputTokens?: number;
    includeAssistantReply?: boolean;
    handoffPrompt?: string;
    handoffPromptPath?: string;
    handoffCooldownTurns?: number;
  };
  semanticReduction?: {
    enabled?: boolean;
    pythonBin?: string;
    timeoutMs?: number;
    llmlinguaModelPath?: string;
    targetRatio?: number;
    minInputChars?: number;
    minSavedChars?: number;
    preselectRatio?: number;
    maxChunkChars?: number;
    embedding?: {
      provider?: "local" | "api" | "none";
      modelPath?: string;
      apiBaseUrl?: string;
      apiKey?: string;
      apiModel?: string;
      requestTimeoutMs?: number;
    };
  };
};

type PluginLogger = {
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type SessionTaskBinding = {
  taskId: string;
  sessionSeq: number;
};

type SessionTopologyManager = {
  getLogicalSessionId(sessionKey: string, upstreamSessionId?: string): string;
  getStatus(sessionKey: string): string;
  listTaskCaches(sessionKey: string): string;
  newTaskCache(sessionKey: string, taskId?: string): string;
  newSession(sessionKey: string): string;
  bindUpstreamSession(sessionKey: string, upstreamSessionId?: string): void;
  getUpstreamSessionId(sessionKey: string): string | null;
  deleteTaskCache(sessionKey: string, taskId?: string): {
    removedTaskId: string;
    removedBindings: number;
    switchedToLogical: string;
  } | null;
};

type RecentTurnBinding = {
  userMessage: string;
  matchKey: string;
  sessionKey: string;
  upstreamSessionId?: string;
  at: number;
};

type ManualBranchRoutingFile = {
  updatedAt?: string;
  bindings?: Record<
    string,
    {
      physicalSessionId?: string;
      sourceTraceId?: string;
      sourcePhysicalSessionId?: string;
      action?: "fork" | "revert" | string;
      updatedAt?: string;
    }
  >;
};

function safeId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const norm = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return norm || "main";
}

function buildLogicalSessionId(taskId: string, sessionSeq: number): string {
  return `ecoclaw-task-${safeId(taskId)}-s${Math.max(1, sessionSeq)}`;
}

function createSessionTopologyManager(): SessionTopologyManager {
  const bindingBySessionKey = new Map<string, SessionTaskBinding>();
  const countersByTaskId = new Map<string, number>();
  const upstreamSessionIdBySessionKey = new Map<string, string>();
  let globalDefaultTaskId: string | null = null;

  function scopedFamilyPrefix(sessionKey: string): string | null {
    const key = (sessionKey || "").trim();
    if (!key.startsWith("scoped:")) return null;
    const parts = key.split(":");
    if (parts.length < 3) return null;
    return `${parts[0]}:${parts[1]}:${parts[2]}`;
  }

  function ensure(sessionKey: string, preferredTaskId?: string): SessionTaskBinding {
    const key = sessionKey || "unknown";
    const existing = bindingBySessionKey.get(key);
    if (existing) return existing;
    const defaultTaskId = safeId(preferredTaskId ?? globalDefaultTaskId ?? `default-${safeId(key)}`);
    const initialSeq = 1;
    const init: SessionTaskBinding = { taskId: defaultTaskId, sessionSeq: initialSeq };
    bindingBySessionKey.set(key, init);
    countersByTaskId.set(defaultTaskId, Math.max(countersByTaskId.get(defaultTaskId) ?? 0, initialSeq));
    return init;
  }

  return {
    getLogicalSessionId(sessionKey: string, upstreamSessionId?: string): string {
      const b = ensure(sessionKey);
      const base = buildLogicalSessionId(b.taskId, b.sessionSeq);
      const upstream = String(
        upstreamSessionId ?? upstreamSessionIdBySessionKey.get(sessionKey) ?? "",
      ).trim();
      if (!upstream) return base;
      return `${base}__oc_${safeId(upstream)}`;
    },
    getStatus(sessionKey: string): string {
      const b = ensure(sessionKey);
      const base = buildLogicalSessionId(b.taskId, b.sessionSeq);
      const upstream = upstreamSessionIdBySessionKey.get(sessionKey) ?? "-";
      return `sessionKey=${sessionKey} task=${b.taskId} logical=${base} seq=${b.sessionSeq} openclawSessionId=${upstream}`;
    },
    listTaskCaches(sessionKey: string): string {
      const current = ensure(sessionKey);
      const taskIds = new Set<string>();
      for (const binding of bindingBySessionKey.values()) taskIds.add(binding.taskId);
      for (const taskId of countersByTaskId.keys()) taskIds.add(taskId);
      const sorted = Array.from(taskIds).sort((a, b) => a.localeCompare(b));
      if (sorted.length === 0) {
        return `No task-cache found.\n${this.getStatus(sessionKey)}`;
      }
      const lines = ["Task-caches:"];
      for (const taskId of sorted) {
        const seqMax = Math.max(1, countersByTaskId.get(taskId) ?? 1);
        const activeBindings = Array.from(bindingBySessionKey.values()).filter((b) => b.taskId === taskId).length;
        const mark = taskId === current.taskId ? "*" : " ";
        lines.push(`${mark} ${taskId} (sessions<=${seqMax}, bindings=${activeBindings})`);
      }
      lines.push("", `current: ${current.taskId} -> ${buildLogicalSessionId(current.taskId, current.sessionSeq)}`);
      return lines.join("\n");
    },
    newTaskCache(sessionKey: string, taskId?: string): string {
      const chosenTaskId = safeId(taskId ?? `task-${Date.now()}`);
      const seq = 1;
      countersByTaskId.set(chosenTaskId, Math.max(countersByTaskId.get(chosenTaskId) ?? 0, seq));
      globalDefaultTaskId = chosenTaskId;
      bindingBySessionKey.set(sessionKey, { taskId: chosenTaskId, sessionSeq: seq });
      const family = scopedFamilyPrefix(sessionKey);
      if (family) {
        for (const [key] of bindingBySessionKey.entries()) {
          if (key === sessionKey) continue;
          if (key === family || key.startsWith(`${family}:`)) {
            bindingBySessionKey.set(key, { taskId: chosenTaskId, sessionSeq: seq });
          }
        }
      }
      return buildLogicalSessionId(chosenTaskId, seq);
    },
    newSession(sessionKey: string): string {
      const current = ensure(sessionKey);
      const next = (countersByTaskId.get(current.taskId) ?? current.sessionSeq) + 1;
      countersByTaskId.set(current.taskId, next);
      const updated: SessionTaskBinding = { taskId: current.taskId, sessionSeq: next };
      bindingBySessionKey.set(sessionKey, updated);
      const family = scopedFamilyPrefix(sessionKey);
      if (family) {
        for (const [key, binding] of bindingBySessionKey.entries()) {
          if (key === sessionKey) continue;
          if (binding.taskId !== current.taskId) continue;
          if (key === family || key.startsWith(`${family}:`)) {
            bindingBySessionKey.set(key, { taskId: current.taskId, sessionSeq: next });
          }
        }
      }
      return buildLogicalSessionId(updated.taskId, updated.sessionSeq);
    },
    bindUpstreamSession(sessionKey: string, upstreamSessionId?: string): void {
      const upstream = String(upstreamSessionId ?? "").trim();
      if (!upstream) return;
      upstreamSessionIdBySessionKey.set(sessionKey, upstream);
    },
    getUpstreamSessionId(sessionKey: string): string | null {
      return upstreamSessionIdBySessionKey.get(sessionKey) ?? null;
    },
    deleteTaskCache(sessionKey: string, taskId?: string) {
      const current = ensure(sessionKey);
      const targetTaskId = safeId(taskId ?? current.taskId);
      let removedBindings = 0;
      for (const [key, binding] of bindingBySessionKey.entries()) {
        if (binding.taskId === targetTaskId) {
          bindingBySessionKey.delete(key);
          removedBindings += 1;
        }
      }
      countersByTaskId.delete(targetTaskId);
      if (globalDefaultTaskId === targetTaskId) {
        globalDefaultTaskId = null;
      }
      if (removedBindings === 0) return null;
      const baseDefaultTaskId = `default-${safeId(sessionKey || "unknown")}`;
      const fallbackTaskId =
        targetTaskId === baseDefaultTaskId
          ? `${baseDefaultTaskId}-r${Date.now().toString(36)}`
          : baseDefaultTaskId;
      const fallback = ensure(sessionKey, fallbackTaskId);
      return {
        removedTaskId: targetTaskId,
        removedBindings,
        switchedToLogical: buildLogicalSessionId(fallback.taskId, fallback.sessionSeq),
      };
    },
  };
}

type EcoClawCmd = {
  kind:
    | "none"
    | "status"
    | "cache_new"
    | "cache_delete"
    | "cache_list"
    | "session_new"
    | "openclaw_session_new"
    | "help";
  taskId?: string;
};

function parseEcoClawCommand(raw: string): EcoClawCmd {
  const text = raw.trim();
  if (!text) return { kind: "none" };
  const bareSlash = text.startsWith("/") ? text.slice(1).trim().toLowerCase() : "";
  if (bareSlash === "new") {
    return { kind: "openclaw_session_new" };
  }
  const normalized = text.startsWith("/") ? text.slice(1).trim() : text;
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "none" };
  if (parts[0].toLowerCase() !== "ecoclaw") return { kind: "none" };
  if (parts.length === 1) return { kind: "help" };

  const scope = parts[1]?.toLowerCase();
  if (scope === "help" || scope === "h" || scope === "--help") return { kind: "help" };
  const action = parts[2]?.toLowerCase();
  if (scope === "status") return { kind: "status" };
  if (scope === "cache" && action === "new") {
    return { kind: "cache_new", taskId: parts[3] };
  }
  if (scope === "cache" && (action === "list" || action === "ls")) {
    return { kind: "cache_list" };
  }
  if (scope === "cache" && (action === "delete" || action === "del" || action === "rm")) {
    return { kind: "cache_delete", taskId: parts[3] };
  }
  if (scope === "session" && action === "new") {
    return { kind: "session_new" };
  }
  return { kind: "help" };
}

function commandHelpText(): string {
  return [
    "EcoClaw commands:",
    "  /ecoclaw help",
    "    作用: 显示这份帮助与示例。",
    "  /ecoclaw status",
    "    作用: 查看当前会话绑定到哪个 task-cache / logical session。",
    "  /ecoclaw cache new [task-id]",
    "    作用: 新建并切换到一个 task-cache（工作区）。",
    "  /ecoclaw cache list",
    "    作用: 列出当前所有 task-cache，并标记当前所在工作区。",
    "  /ecoclaw cache delete [task-id]",
    "    作用: 删除指定（或当前）task-cache，并回退到默认绑定。",
    "  /ecoclaw session new",
    "    作用: 在当前 task-cache 内开启下一条 logical session 分支。",
    "",
    "示例:",
    "  /ecoclaw cache new demo-task",
    "  /ecoclaw cache list",
    "  /ecoclaw session new",
    "  /ecoclaw status",
    "",
    "说明:",
    "  - 请在 TUI 里优先使用 slash 命令: /ecoclaw ...",
    "  - 1 个 task-cache 可以包含多个 session。",
  ].join("\n");
}

function normalizeConfig(raw: unknown): Required<Omit<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey">> &
  Pick<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey"> {
  const cfg = (raw ?? {}) as EcoClawPluginConfig;
  const defaultStateDir = join(homedir(), ".openclaw", "ecoclaw-plugin-state");
  const stateDir = cfg.stateDir ?? defaultStateDir;
  const compaction = cfg.compaction ?? {};
  const handoff = cfg.handoff ?? {};
  const semantic = cfg.semanticReduction ?? {};
  const semanticEmbedding = semantic.embedding ?? {};
  return {
    enabled: cfg.enabled ?? true,
    logLevel: cfg.logLevel ?? "info",
    proxyBaseUrl: cfg.proxyBaseUrl,
    proxyApiKey: cfg.proxyApiKey,
    stateDir,
    debugTapProviderTraffic: cfg.debugTapProviderTraffic ?? false,
    debugTapPath: cfg.debugTapPath ?? join(stateDir, "ecoclaw", "provider-traffic.jsonl"),
    proxyAutostart: cfg.proxyAutostart ?? true,
    proxyPort: Math.max(1025, Math.min(65535, cfg.proxyPort ?? 17667)),
    compaction: {
      enabled: compaction.enabled ?? true,
      autoForkOnPolicy: compaction.autoForkOnPolicy ?? true,
      summaryGenerationMode:
        compaction.summaryGenerationMode === "llm_full_context" ? "llm_full_context" : "heuristic",
      summaryFallbackToHeuristic: compaction.summaryFallbackToHeuristic ?? true,
      summaryMaxOutputTokens: Math.max(128, Math.min(8192, compaction.summaryMaxOutputTokens ?? 1200)),
      includeAssistantReply: compaction.includeAssistantReply ?? true,
      summaryPrompt: typeof compaction.summaryPrompt === "string" ? compaction.summaryPrompt : undefined,
      summaryPromptPath: typeof compaction.summaryPromptPath === "string" ? compaction.summaryPromptPath : undefined,
      resumePrefixPrompt:
        typeof compaction.resumePrefixPrompt === "string" ? compaction.resumePrefixPrompt : undefined,
      resumePrefixPromptPath:
        typeof compaction.resumePrefixPromptPath === "string" ? compaction.resumePrefixPromptPath : undefined,
      compactionCooldownTurns: Math.max(0, compaction.compactionCooldownTurns ?? 6),
    },
    handoff: {
      enabled: handoff.enabled ?? false,
      handoffGenerationMode:
        handoff.handoffGenerationMode === "llm_full_context" ? "llm_full_context" : "heuristic",
      handoffFallbackToHeuristic: handoff.handoffFallbackToHeuristic ?? true,
      handoffMaxOutputTokens: Math.max(128, Math.min(8192, handoff.handoffMaxOutputTokens ?? 900)),
      includeAssistantReply: handoff.includeAssistantReply ?? true,
      handoffPrompt: typeof handoff.handoffPrompt === "string" ? handoff.handoffPrompt : undefined,
      handoffPromptPath: typeof handoff.handoffPromptPath === "string" ? handoff.handoffPromptPath : undefined,
      handoffCooldownTurns: Math.max(0, handoff.handoffCooldownTurns ?? 4),
    },
    semanticReduction: {
      enabled: semantic.enabled ?? false,
      pythonBin: semantic.pythonBin ?? "python",
      timeoutMs: Math.max(1000, Math.min(300000, semantic.timeoutMs ?? 120000)),
      llmlinguaModelPath: semantic.llmlinguaModelPath,
      targetRatio:
        typeof semantic.targetRatio === "number"
          ? Math.min(0.95, Math.max(0.05, semantic.targetRatio))
          : 0.55,
      minInputChars: Math.max(256, semantic.minInputChars ?? 4000),
      minSavedChars: Math.max(32, semantic.minSavedChars ?? 200),
      preselectRatio:
        typeof semantic.preselectRatio === "number"
          ? Math.min(1, Math.max(0.05, semantic.preselectRatio))
          : 0.8,
      maxChunkChars: Math.max(256, semantic.maxChunkChars ?? 1400),
      embedding: {
        provider:
          semanticEmbedding.provider === "local" ||
          semanticEmbedding.provider === "api" ||
          semanticEmbedding.provider === "none"
            ? semanticEmbedding.provider
            : "none",
        modelPath: semanticEmbedding.modelPath,
        apiBaseUrl: semanticEmbedding.apiBaseUrl,
        apiKey: semanticEmbedding.apiKey,
        apiModel: semanticEmbedding.apiModel,
        requestTimeoutMs: Math.max(1000, Math.min(120000, semanticEmbedding.requestTimeoutMs ?? 30000)),
      },
    },
  };
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

const OPENCLAW_SENDER_METADATA_BLOCK_RE =
  /(?:^|\n{1,2})Sender\s+\(untrusted metadata\):\s*```json\s*[\s\S]*?```(?:\n{1,2}|$)/gi;
const OPENCLAW_SENDER_METADATA_DETECT_RE =
  /Sender\s+\(untrusted metadata\):\s*```json/gi;

function stripUntrustedSenderMetadata(text: string): string {
  const raw = String(text ?? "");
  const withoutMetadata = raw.replace(OPENCLAW_SENDER_METADATA_BLOCK_RE, "\n\n");
  return withoutMetadata.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeUserMessageText(text: string): string {
  return stripUntrustedSenderMetadata(String(text ?? ""));
}

function normalizeTurnBindingMessage(text: string): string {
  return normalizeUserMessageText(String(text ?? "").trim()).trim();
}

function countSenderMetadataBlocks(value: any): number {
  const matches = String(extractInputText(value) ?? "").match(OPENCLAW_SENDER_METADATA_DETECT_RE);
  return matches ? matches.length : 0;
}

function normalizeContentNode(value: any): { value: any; changed: boolean } {
  if (typeof value === "string") {
    const next = normalizeUserMessageText(value);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const normalized = normalizeContentNode(item);
      if (normalized.changed) changed = true;
      return normalized.value;
    });
    return { value: next, changed };
  }
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }
  let changed = false;
  const next: Record<string, any> = Array.isArray(value) ? [] : { ...value };
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeContentNode(child);
    if (normalized.changed) {
      changed = true;
      next[key] = normalized.value;
    }
  }
  return { value: changed ? next : value, changed };
}

function normalizeContentValue(value: any): { value: any; changed: boolean } {
  return normalizeContentNode(value);
}

function summarizeToolsFingerprint(tools: any): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return "unknown";
    const name = String((tool as any).name ?? (tool as any).type ?? "unknown");
    const type = String((tool as any).type ?? "unknown");
    const params = JSON.stringify((tool as any).parameters ?? {});
    return `${type}:${name}:${params.length}`;
  });
}

function findDeveloperPromptText(input: any): string {
  if (!Array.isArray(input)) return "";
  const developer = input.find((item) => item && typeof item === "object" && String(item.role) === "developer");
  if (!developer) return "";
  return extractInputText([developer]);
}

function computeStablePromptCacheKey(
  model: string,
  instructions: string,
  developerText: string,
  tools: any,
): string {
  const seed = JSON.stringify({
    v: 2,
    model: normalizeProxyModelId(model),
    instructions: normalizeText(instructions),
    developer: normalizeText(developerText),
    tools: summarizeToolsFingerprint(tools),
  });
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return `ecoclaw-pfx-${digest}`;
}

function rewritePayloadForStablePrefix(payload: any, model: string): {
  promptCacheKey: string;
  userContentRewrites: number;
  senderMetadataBlocksBefore: number;
  senderMetadataBlocksAfter: number;
  developerTextForKey: string;
} {
  let userContentRewrites = 0;
  let senderMetadataBlocksBefore = 0;
  let senderMetadataBlocksAfter = 0;
  if (Array.isArray(payload?.input)) {
    payload.input = payload.input.map((item: any) => {
      if (!item || typeof item !== "object") return item;
      if (String(item.role ?? "") !== "user") return item;
      if (item.__ecoclaw_replay_raw === true) return item;
      senderMetadataBlocksBefore += countSenderMetadataBlocks(item.content);
      const normalized = normalizeContentValue(item.content);
      if (!normalized.changed) {
        senderMetadataBlocksAfter += countSenderMetadataBlocks(item.content);
        return item;
      }
      userContentRewrites += 1;
      const nextItem = {
        ...item,
        content: normalized.value,
      };
      senderMetadataBlocksAfter += countSenderMetadataBlocks(nextItem.content);
      return nextItem;
    });
  }

  const developerTextForKey = findDeveloperPromptText(payload?.input);
  const stablePromptCacheKey = computeStablePromptCacheKey(
    model,
    String(payload?.instructions ?? ""),
    developerTextForKey,
    payload?.tools,
  );
  payload.prompt_cache_key = stablePromptCacheKey;
  return {
    promptCacheKey: stablePromptCacheKey,
    userContentRewrites,
    senderMetadataBlocksBefore,
    senderMetadataBlocksAfter,
    developerTextForKey,
  };
}

function stripInternalPayloadMarkers(payload: any): void {
  if (!payload || !Array.isArray(payload.input)) return;
  payload.input = payload.input.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    if (!Object.prototype.hasOwnProperty.call(item, "__ecoclaw_replay_raw")) return item;
    const clone = { ...item };
    delete clone.__ecoclaw_replay_raw;
    return clone;
  });
}

function extractInputText(input: any): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const content = (entry as any).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .map((c: any) => {
              if (!c || typeof c !== "object") return "";
              if (typeof c.text === "string") return c.text;
              if (typeof c.content === "string") return c.content;
              return "";
            })
            .join("\n");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function findDeveloperAndPrimaryUser(input: any): {
  developerText: string;
  developerIndex: number;
  developerItem: any;
  userIndex: number;
  userItem: any | null;
} | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  let developerIndex = -1;
  let developerItem: any = null;
  let developerText = "";
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object" || String((item as any).role) !== "developer") continue;
    const text =
      typeof (item as any).content === "string"
        ? String((item as any).content)
        : extractInputText([item]);
    if (!text.trim()) continue;
    developerIndex = i;
    developerItem = item;
    developerText = text;
    break;
  }
  if (developerIndex < 0 || !developerItem) return null;

  let userIndex = -1;
  for (let i = developerIndex + 1; i < input.length; i += 1) {
    const item = input[i];
    if (item && typeof item === "object" && String((item as any).role) === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) {
    userIndex = input.findIndex((item) => item && typeof item === "object" && String((item as any).role) === "user");
  }
  const userItem = userIndex >= 0 ? input[userIndex] : null;
  return { developerText, developerIndex, developerItem, userIndex, userItem };
}

type DeveloperRewrite = {
  canonicalDeveloperText: string;
  forwardedDeveloperText: string;
  dynamicContextText: string;
  changed: boolean;
  workdir?: string;
  agentId?: string;
};

function rewriteDeveloperPromptForRootLink(developerText: string): DeveloperRewrite {
  const raw = String(developerText ?? "");
  if (!raw.trim()) {
    return {
      canonicalDeveloperText: raw,
      forwardedDeveloperText: raw,
      dynamicContextText: "",
      changed: false,
    };
  }
  const workdirMatch = raw.match(/Your working directory is:\s*([^\n\r]+)/i);
  const runtimeAgentMatch = raw.match(/Runtime:\s*agent=([^|\n\r]+)/i);
  const workdir = workdirMatch?.[1]?.trim();
  const agentId = runtimeAgentMatch?.[1]?.trim();

  let canonical = raw;
  if (workdir) {
    canonical = canonical.split(workdir).join("<WORKDIR>");
  }
  canonical = canonical.replace(/(Runtime:\s*agent=)[^|\n\r]+/gi, "$1<AGENT_ID>");
  canonical = canonical.replace(
    /^##\s+<WORKDIR>[\\/]+([^\\/\n\r]+)$/gm,
    "## $1",
  );
  canonical = canonical.replace(
    /^##\s+(?:[A-Za-z]:[\\/]|\/)[^\n\r]*[\\/]+([^\\/\n\r]+)$/gm,
    "## $1",
  );
  canonical = canonical.replace(
    /(\[MISSING\]\s+Expected at:\s*)<WORKDIR>[\\/]+([^\\/\n\r]+)/g,
    "$1$2",
  );
  canonical = canonical.replace(
    /(\[MISSING\]\s+Expected at:\s*)(?:[A-Za-z]:[\\/]|\/)[^\n\r]*[\\/]+([^\\/\n\r]+)/g,
    "$1$2",
  );

  const dynamicLines: string[] = [];
  if (workdir) dynamicLines.push(`- WORKDIR: ${workdir}`);
  if (agentId) dynamicLines.push(`- AGENT_ID: ${agentId}`);
  const dynamicTail =
    dynamicLines.length > 0
      ? `\n${dynamicLines.join("\n")}`
      : "";
  return {
    canonicalDeveloperText: canonical,
    forwardedDeveloperText: canonical,
    dynamicContextText: dynamicTail.trim(),
    changed: canonical !== raw || dynamicTail.length > 0,
    workdir,
    agentId,
  };
}

function prependTextToContent(content: any, extraText: string): any {
  const extra = String(extraText ?? "").trim();
  if (!extra) return content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? `${extra}\n\n${content}` : extra;
  }
  if (Array.isArray(content)) {
    const next = content.map((item) => (item && typeof item === "object" ? { ...item } : item));
    for (let i = 0; i < next.length; i += 1) {
      const item = next[i];
      if (!item || typeof item !== "object") continue;
      if (typeof (item as any).text === "string") {
        (item as any).text = (item as any).text.trim().length > 0
          ? `${extra}\n\n${String((item as any).text)}`
          : extra;
        return next;
      }
      if (typeof (item as any).content === "string") {
        (item as any).content = (item as any).content.trim().length > 0
          ? `${extra}\n\n${String((item as any).content)}`
          : extra;
        return next;
      }
    }
    next.unshift({ type: "input_text", text: extra });
    return next;
  }
  return extra;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function extractItemText(item: any): string {
  if (!item || typeof item !== "object") return "";
  return extractInputText([item]).trim();
}

function findLastUserItem(input: any): { userIndex: number; userItem: any | null } | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (String((item as any).role) === "user") {
      return { userIndex: i, userItem: item };
    }
  }
  return null;
}

function stripReplyTag(text: string): string {
  return String(text ?? "").replace(/^\s*\[\[[^\]]+\]\]\s*/u, "").trim();
}

function safeStateSessionId(input: string): string {
  return String(input ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function readJsonlRows(path: string): Promise<any[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readManualBranchRouting(stateDir: string): Promise<ManualBranchRoutingFile> {
  const path = join(stateDir, "ecoclaw", "controls", "manual-branch-routing.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as ManualBranchRoutingFile;
  } catch {
    return {};
  }
}

function recentTurnBindingsPath(stateDir: string): string {
  return join(stateDir, "ecoclaw", "controls", "recent-turn-bindings.json");
}

function loadRecentTurnBindingsFromState(stateDir: string): RecentTurnBinding[] {
  try {
    const parsed = JSON.parse(readFileSync(recentTurnBindingsPath(stateDir), "utf8"));
    if (!Array.isArray(parsed)) return [];
    const out: RecentTurnBinding[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const userMessage = String((entry as any).userMessage ?? "").trim();
      const matchKey =
        String((entry as any).matchKey ?? "").trim() || normalizeTurnBindingMessage(userMessage);
      const sessionKey = String((entry as any).sessionKey ?? "").trim();
      const upstreamSessionId = String((entry as any).upstreamSessionId ?? "").trim() || undefined;
      const atRaw = Number((entry as any).at ?? 0);
      const at = Number.isFinite(atRaw) ? atRaw : 0;
      if (!userMessage || !matchKey || !sessionKey || !at) continue;
      out.push({ userMessage, matchKey, sessionKey, upstreamSessionId, at });
    }
    return out;
  } catch {
    return [];
  }
}

function persistRecentTurnBindingsToState(stateDir: string, bindings: RecentTurnBinding[]): void {
  try {
    mkdirSync(dirname(recentTurnBindingsPath(stateDir)), { recursive: true });
    writeFileSync(recentTurnBindingsPath(stateDir), JSON.stringify(bindings.slice(-128), null, 2), "utf8");
  } catch {
    // Best-effort only: provider-side lookup can still rely on in-memory bindings if persistence fails.
  }
}

function extractStoredToolSegments(record: any): Array<{ text: string; toolName?: string }> {
  const pools = [
    Array.isArray(record?.segments) ? record.segments : [],
    Array.isArray(record?.trace?.initialContext?.segments) ? record.trace.initialContext.segments : [],
    Array.isArray(record?.trace?.finalContext?.segments) ? record.trace.finalContext.segments : [],
  ];
  const out: Array<{ text: string; toolName?: string }> = [];
  const seen = new Set<string>();
  for (const pool of pools) {
    for (const segment of pool) {
      if (!segment || typeof segment !== "object") continue;
      const metadata = (segment as any).metadata && typeof (segment as any).metadata === "object"
        ? ((segment as any).metadata as Record<string, unknown>)
        : {};
      const toolPayload = metadata.toolPayload && typeof metadata.toolPayload === "object"
        ? (metadata.toolPayload as Record<string, unknown>)
        : {};
      const reduction = metadata.reduction && typeof metadata.reduction === "object"
        ? (metadata.reduction as Record<string, unknown>)
        : {};
      const source = String((segment as any).source ?? "");
      const isTool = Boolean(
        metadata.isToolPayload ||
          toolPayload.enabled ||
          reduction.target === "tool_payload" ||
          source.includes("tool") ||
          source.includes("observation"),
      );
      const text = typeof (segment as any).text === "string" ? String((segment as any).text).trim() : "";
      if (!isTool || !text) continue;
      const key = `${String((segment as any).id ?? "")}:${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        text,
        toolName:
          typeof toolPayload.toolName === "string" && toolPayload.toolName.trim().length > 0
            ? toolPayload.toolName.trim()
            : undefined,
      });
    }
  }
  return out;
}

async function buildManualReplayHistory(
  stateDir: string,
  physicalSessionId: string,
): Promise<any[]> {
  const turnsPath = join(
    stateDir,
    "ecoclaw",
    "sessions",
    safeStateSessionId(physicalSessionId),
    "turns.jsonl",
  );
  const rows = await readJsonlRows(turnsPath);
  const input: any[] = [];
  for (const row of rows) {
    const prompt = typeof row?.prompt === "string" ? String(row.prompt).trim() : "";
    if (prompt) input.push({ role: "user", content: prompt, __ecoclaw_replay_raw: true });
    for (const tool of extractStoredToolSegments(row)) {
      input.push({
        role: "tool",
        content: tool.text,
        ...(tool.toolName ? { name: tool.toolName } : {}),
      });
    }
    const responseRaw =
      typeof row?.response === "string"
        ? row.response
        : typeof row?.responsePreview === "string"
          ? row.responsePreview
          : "";
    const response = stripReplyTag(responseRaw);
    if (response) input.push({ role: "assistant", content: response });
  }
  return input;
}

async function maybeApplyManualBranchReplay(
  payload: any,
  cfg: ReturnType<typeof normalizeConfig>,
  topology: SessionTopologyManager,
  resolveTurnBinding: (userMessage: string) => RecentTurnBinding | null,
): Promise<null | {
  logicalSessionId: string;
  physicalSessionId: string;
  replayItemCount: number;
}> {
  if (!cfg.stateDir) return null;
  if (!payload || !Array.isArray(payload.input)) return null;
  const devAndUser = findDeveloperAndPrimaryUser(payload.input);
  const lastUser = findLastUserItem(payload.input);
  const currentUserItem = lastUser?.userItem ?? devAndUser?.userItem ?? null;
  const currentUserText = extractItemText(currentUserItem);
  if (!currentUserText) return null;

  const turnBinding = resolveTurnBinding(currentUserText);
  if (!turnBinding) return null;
  const logicalSessionId = topology.getLogicalSessionId(
    turnBinding.sessionKey,
    turnBinding.upstreamSessionId,
  );
  const manualRouting = await readManualBranchRouting(cfg.stateDir);
  const manualBinding = manualRouting.bindings?.[logicalSessionId];
  const physicalSessionId = String(manualBinding?.physicalSessionId ?? "").trim();
  if (!physicalSessionId) return null;

  const replayItems = await buildManualReplayHistory(cfg.stateDir, physicalSessionId);
  const dedupedReplayItems =
    replayItems.length > 0 &&
    String(replayItems[replayItems.length - 1]?.role ?? "") === "user" &&
    extractItemText(replayItems[replayItems.length - 1]) === currentUserText
      ? replayItems.slice(0, -1)
      : replayItems;
  const nextInput: any[] = [];
  if (devAndUser?.developerItem) {
    nextInput.push(cloneJson(devAndUser.developerItem));
  }
  nextInput.push(...dedupedReplayItems.map((item) => cloneJson(item)));
  nextInput.push(cloneJson(currentUserItem));
  payload.input = nextInput;
  return {
    logicalSessionId,
    physicalSessionId,
    replayItemCount: dedupedReplayItems.length,
  };
}

function normalizeProxyModelId(model: string): string {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("ecoclaw/")) {
    return trimmed.slice("ecoclaw/".length).trim();
  }
  return trimmed;
}

type UpstreamModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

type UpstreamConfig = {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  models: UpstreamModelDef[];
};

async function detectUpstreamConfig(logger: Required<PluginLogger>): Promise<UpstreamConfig | null> {
  const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as any;
    const providers = parsed?.models?.providers ?? {};
    const preferred = ["gmn", "openai", "dica", "qwen-portal", "bailian"];
    const selectedProvider = preferred.find((id) => providers?.[id]?.baseUrl && providers?.[id]?.apiKey) ?? Object.keys(providers)[0];
    if (!selectedProvider) return null;
    const p = providers[selectedProvider];
    const models = Array.isArray(p?.models) ? p.models : [];
    const normalized: UpstreamModelDef[] = models
      .filter((m: any) => typeof m?.id === "string" && m.id.trim())
      .map((m: any) => ({
        id: String(m.id),
        name: String(m.name ?? m.id),
        reasoning: Boolean(m.reasoning ?? false),
        input: Array.isArray(m.input) ? m.input.filter((x: any) => x === "text" || x === "image") : ["text"],
        contextWindow: Number(m.contextWindow ?? 128000),
        maxTokens: Number(m.maxTokens ?? 8192),
      }));
    if (!p?.baseUrl || !p?.apiKey) return null;
    return {
      providerId: selectedProvider,
      baseUrl: String(p.baseUrl).replace(/\/+$/, ""),
      apiKey: String(p.apiKey),
      models: normalized.length > 0 ? normalized : [{
        id: "gpt-5.4",
        name: "gpt-5.4",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 8192,
      }],
    };
  } catch (err) {
    logger.warn(`[ecoclaw] detect upstream config failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function ensureExplicitProxyModelsInConfig(
  proxyBaseUrl: string,
  upstream: UpstreamConfig,
  logger: Required<PluginLogger>,
): Promise<void> {
  const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(cfgPath, "utf8");
    const doc = JSON.parse(raw) as any;
    doc.models = doc.models ?? {};
    doc.models.providers = doc.models.providers ?? {};
    doc.agents = doc.agents ?? {};
    doc.agents.defaults = doc.agents.defaults ?? {};
    doc.agents.defaults.models = doc.agents.defaults.models ?? {};

    const existingProvider = doc.models.providers.ecoclaw ?? {};
    const desiredModels = upstream.models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    const nextProvider = {
      ...existingProvider,
      baseUrl: proxyBaseUrl,
      apiKey: "ecoclaw-local",
      api: "openai-responses",
      authHeader: false,
      models: desiredModels,
    };
    doc.models.providers.ecoclaw = nextProvider;

    for (const model of upstream.models) {
      const key = `ecoclaw/${model.id}`;
      if (!doc.agents.defaults.models[key]) {
        doc.agents.defaults.models[key] = {};
      }
    }

    const nextRaw = JSON.stringify(doc, null, 2);
    if (nextRaw !== raw) {
      await writeFile(cfgPath, nextRaw, "utf8");
      logger.info(
        `[ecoclaw] synced explicit model keys into openclaw.json (${upstream.models.length} models).`,
      );
    }
  } catch (err) {
    logger.warn(
      `[ecoclaw] sync explicit proxy models failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function startEmbeddedResponsesProxy(
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
  topology: SessionTopologyManager,
  resolveTurnBinding: (userMessage: string) => RecentTurnBinding | null,
): Promise<{ baseUrl: string; upstream: UpstreamConfig; close: () => Promise<void> } | null> {
  if (!cfg.proxyAutostart) return null;
  const upstream = await detectUpstreamConfig(logger);
  if (!upstream) {
    logger.warn("[ecoclaw] no upstream provider discovered; proxy disabled.");
    return null;
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body);
      const model = String(payload?.model ?? "");
      const upstreamModel = normalizeProxyModelId(model);
      if (upstreamModel && upstreamModel !== model) {
        payload.model = upstreamModel;
      }
      const manualReplay = await maybeApplyManualBranchReplay(
        payload,
        cfg,
        topology,
        resolveTurnBinding,
      );
      const instructions = normalizeText(String(payload?.instructions ?? ""));
      const devAndUser = findDeveloperAndPrimaryUser(payload?.input);
      const firstTurnCandidate = Boolean(devAndUser);
      const developerRewrite = devAndUser
        ? rewriteDeveloperPromptForRootLink(devAndUser.developerText)
        : null;
      const developerCanonicalText = normalizeText(
        developerRewrite?.canonicalDeveloperText ?? devAndUser?.developerText ?? "",
      );
      const developerForwardedText = normalizeText(
        developerRewrite?.forwardedDeveloperText ?? devAndUser?.developerText ?? "",
      );
      const originalPromptCacheKey =
        typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
          ? String(payload.prompt_cache_key)
          : "";
      if (devAndUser && developerRewrite && Array.isArray(payload?.input) && devAndUser.developerIndex >= 0) {
        payload.input[devAndUser.developerIndex] = {
          ...(devAndUser.developerItem ?? payload.input[devAndUser.developerIndex]),
          role: "developer",
          content: developerRewrite.forwardedDeveloperText,
        };
        if (developerRewrite.dynamicContextText && devAndUser.userIndex >= 0) {
          payload.input[devAndUser.userIndex] = {
            ...(devAndUser.userItem ?? payload.input[devAndUser.userIndex]),
            role: "user",
            content: prependTextToContent(
              (devAndUser.userItem ?? payload.input[devAndUser.userIndex])?.content,
              developerRewrite.dynamicContextText,
            ),
          };
        }
      }
      const stableRewrite = rewritePayloadForStablePrefix(payload, model);
      stripInternalPayloadMarkers(payload);
      logger.info(
        `[ecoclaw] proxy request model=${model || "unknown"} upstreamModel=${upstreamModel || "unknown"} instrChars=${instructions.length} cacheKey=${stableRewrite.promptCacheKey} userContentRewrites=${stableRewrite.userContentRewrites} senderBlocks=${stableRewrite.senderMetadataBlocksBefore}->${stableRewrite.senderMetadataBlocksAfter}`,
      );
      if (cfg.debugTapProviderTraffic) {
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_inbound",
          model,
          upstreamModel,
          instructionsChars: instructions.length,
          inputChars: normalizeText(extractInputText(payload?.input)).length,
          devUserDetected: Boolean(devAndUser),
          firstTurnCandidate,
          developerChars: developerForwardedText.length,
          developerCanonicalChars: developerCanonicalText.length,
          developerRewritten: Boolean(developerRewrite?.changed),
          developerRewriteWorkdir: developerRewrite?.workdir ?? "",
          developerRewriteAgentId: developerRewrite?.agentId ?? "",
          manualReplayLogicalSessionId: manualReplay?.logicalSessionId ?? "",
          manualReplayPhysicalSessionId: manualReplay?.physicalSessionId ?? "",
          manualReplayItemCount: manualReplay?.replayItemCount ?? 0,
          originalPromptCacheKey,
          rewrittenPromptCacheKey: stableRewrite.promptCacheKey,
          userContentRewrites: stableRewrite.userContentRewrites,
          senderMetadataBlocksBefore: stableRewrite.senderMetadataBlocksBefore,
          senderMetadataBlocksAfter: stableRewrite.senderMetadataBlocksAfter,
          payload,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      payload.prompt_cache_retention = "24h";
      const upstreamResp = await fetch(`${upstream.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${upstream.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      const txt = await upstreamResp.text();
      {
        const forwardedRecord = {
          at: new Date().toISOString(),
          stage: "proxy_forwarded",
          model,
          upstreamModel,
          forwardedHasPrev: typeof payload?.previous_response_id === "string" && payload.previous_response_id.length > 0,
          forwardedPromptCacheKey:
            typeof payload?.prompt_cache_key === "string" ? payload.prompt_cache_key : null,
          forwardedPromptCacheRetention:
            typeof payload?.prompt_cache_retention === "string" ? payload.prompt_cache_retention : null,
          forwardedInputCount: Array.isArray(payload?.input) ? payload.input.length : -1,
          forwardedInputRoles: Array.isArray(payload?.input)
            ? payload.input.map((x: any) => String(x?.role ?? ""))
            : [],
          forwardedManualReplayLogicalSessionId: manualReplay?.logicalSessionId ?? null,
          forwardedManualReplayPhysicalSessionId: manualReplay?.physicalSessionId ?? null,
          forwardedManualReplayItemCount: manualReplay?.replayItemCount ?? 0,
          forwardedDeveloperChars:
            Array.isArray(payload?.input) &&
            payload.input.length > 0 &&
            String(payload.input[0]?.role) === "developer" &&
            typeof payload.input[0]?.content === "string"
              ? String(payload.input[0].content).length
              : 0,
          payload,
        };
        await appendJsonl(cfg.debugTapPath, forwardedRecord);
      }
      if (cfg.debugTapProviderTraffic) {
        let parsedResponse: any = null;
        try {
          parsedResponse = JSON.parse(txt);
        } catch {}
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_outbound",
          model,
          upstreamModel,
          status: upstreamResp.status,
          responseId:
            typeof parsedResponse?.id === "string"
              ? parsedResponse.id
              : typeof parsedResponse?.response?.id === "string"
                ? parsedResponse.response.id
                : null,
          previousResponseId:
            typeof parsedResponse?.previous_response_id === "string"
              ? parsedResponse.previous_response_id
              : typeof parsedResponse?.response?.previous_response_id === "string"
                ? parsedResponse.response.previous_response_id
                : null,
          promptCacheKey:
            typeof parsedResponse?.prompt_cache_key === "string"
              ? parsedResponse.prompt_cache_key
              : typeof parsedResponse?.response?.prompt_cache_key === "string"
                ? parsedResponse.response.prompt_cache_key
                : null,
          promptCacheRetention:
            typeof parsedResponse?.prompt_cache_retention === "string"
              ? parsedResponse.prompt_cache_retention
              : typeof parsedResponse?.response?.prompt_cache_retention === "string"
                ? parsedResponse.response.prompt_cache_retention
                : null,
          usage:
            parsedResponse?.usage ??
            parsedResponse?.response?.usage ??
            null,
          responseText: txt,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      res.statusCode = upstreamResp.status;
      res.setHeader("content-type", upstreamResp.headers.get("content-type") ?? "application/json");
      res.end(txt);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.proxyPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${cfg.proxyPort}/v1`;
  logger.info(`[ecoclaw] embedded responses proxy listening at ${baseUrl}`);
  return {
    baseUrl,
    upstream,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function maybeInstallProviderTrafficTap(
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
  topology: SessionTopologyManager,
  resolveTurnBinding: (userMessage: string) => RecentTurnBinding | null,
): void {
  const g = globalThis as any;
  if (g.__ecoclaw_provider_tap_installed__) return;
  const origFetch = g.fetch;
  if (typeof origFetch !== "function") {
    logger.warn("[ecoclaw] provider interception requested but global fetch is unavailable.");
    return;
  }

  g.__ecoclaw_provider_tap_installed__ = true;
  g.fetch = async (input: any, init?: any) => {
    let effectiveInput = input;
    let effectiveInit = init;
    let url = "";
    try {
      url =
        typeof effectiveInput === "string"
          ? effectiveInput
          : typeof effectiveInput?.url === "string"
            ? effectiveInput.url
            : "";
    } catch {
      url = "";
    }
    const lower = url.toLowerCase();
    const isResponsesCall = lower.includes("/responses");
    const isChatCompletionsCall = lower.includes("/chat/completions");
    const isProviderCall = isResponsesCall || isChatCompletionsCall;

    let reqBody = "";
    let bodySource: "init" | "request" | "none" = "none";
    if (isProviderCall) {
      try {
        if (typeof effectiveInit?.body === "string") {
          reqBody = effectiveInit.body;
          bodySource = "init";
        } else if (effectiveInput && typeof effectiveInput.clone === "function") {
          const clone = effectiveInput.clone();
          reqBody = await clone.text();
          bodySource = reqBody ? "request" : "none";
        }
      } catch {
        reqBody = "";
        bodySource = "none";
      }
    }

    if (isProviderCall && reqBody) {
      try {
        const parsedBody = JSON.parse(reqBody);
        const manualReplay = isResponsesCall
          ? await maybeApplyManualBranchReplay(parsedBody, cfg, topology, resolveTurnBinding)
          : null;
        const devAndUser = isResponsesCall ? findDeveloperAndPrimaryUser(parsedBody?.input) : null;
        const developerRewrite = devAndUser
          ? rewriteDeveloperPromptForRootLink(devAndUser.developerText)
          : null;
        if (
          devAndUser &&
          developerRewrite &&
          Array.isArray(parsedBody?.input) &&
          devAndUser.developerIndex >= 0 &&
          developerRewrite.changed
        ) {
          parsedBody.input[devAndUser.developerIndex] = {
            ...(devAndUser.developerItem ?? parsedBody.input[devAndUser.developerIndex]),
            role: "developer",
            content: developerRewrite.forwardedDeveloperText,
          };
          if (developerRewrite.dynamicContextText && devAndUser.userIndex >= 0) {
            parsedBody.input[devAndUser.userIndex] = {
              ...(devAndUser.userItem ?? parsedBody.input[devAndUser.userIndex]),
              role: "user",
              content: prependTextToContent(
                (devAndUser.userItem ?? parsedBody.input[devAndUser.userIndex])?.content,
                developerRewrite.dynamicContextText,
              ),
            };
          }
        }
        const originalPromptCacheKey =
          typeof parsedBody?.prompt_cache_key === "string" && parsedBody.prompt_cache_key.trim().length > 0
            ? String(parsedBody.prompt_cache_key)
            : "";
        const stableRewrite = rewritePayloadForStablePrefix(parsedBody, String(parsedBody?.model ?? ""));
        stripInternalPayloadMarkers(parsedBody);
        if (isResponsesCall) {
          parsedBody.prompt_cache_retention = "24h";
        }
        const rewrittenBody = JSON.stringify(parsedBody);
        reqBody = rewrittenBody;
        if (bodySource === "init") {
          effectiveInit = {
            ...(effectiveInit ?? {}),
            body: rewrittenBody,
          };
        } else if (bodySource === "request" && effectiveInput && typeof Request !== "undefined" && effectiveInput instanceof Request) {
          effectiveInput = new Request(effectiveInput, {
            method: effectiveInput.method,
            headers: new Headers(effectiveInput.headers),
            body: rewrittenBody,
          });
        }
        await appendJsonl(cfg.debugTapPath, {
          at: new Date().toISOString(),
          stage: "provider_rewrite",
          url,
          manualReplayLogicalSessionId: manualReplay?.logicalSessionId ?? "",
          manualReplayPhysicalSessionId: manualReplay?.physicalSessionId ?? "",
          manualReplayItemCount: manualReplay?.replayItemCount ?? 0,
          originalPromptCacheKey,
          rewrittenPromptCacheKey: stableRewrite.promptCacheKey,
          userContentRewrites: stableRewrite.userContentRewrites,
          senderMetadataBlocksBefore: stableRewrite.senderMetadataBlocksBefore,
          senderMetadataBlocksAfter: stableRewrite.senderMetadataBlocksAfter,
          developerPromptRewritten: Boolean(developerRewrite?.changed),
          developerRewriteWorkdir: developerRewrite?.workdir ?? "",
          developerRewriteAgentId: developerRewrite?.agentId ?? "",
          bodySource,
        });
      } catch {
        // Ignore non-JSON provider bodies.
      }
    }

    const startedAt = new Date().toISOString();
    const method = String(effectiveInit?.method ?? effectiveInput?.method ?? "GET").toUpperCase();
    const res = await origFetch(effectiveInput, effectiveInit);

    if (isProviderCall) {
      void (async () => {
        try {
          const clone = res.clone();
          const txt = await clone.text();
          let parsed: any = undefined;
          try {
            parsed = JSON.parse(txt);
          } catch {
            parsed = undefined;
          }
          const usage =
            parsed?.usage ??
            parsed?.response?.usage ??
            parsed?.data?.usage ??
            undefined;
          const responseText = extractProviderResponseText(txt, parsed);
          const rec = {
            at: startedAt,
            method,
            url,
            status: Number((res as any)?.status ?? 0),
            requestBody: reqBody || undefined,
            responseUsage: usage || undefined,
            responseText: responseText || undefined,
            responseBody: parsed ?? (txt ? txt.slice(0, 4000) : undefined),
          };
          await appendJsonl(cfg.debugTapPath, rec);
        } catch (err) {
          logger.warn(
            `[ecoclaw] provider tap write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }
    return res;
  };
  if (cfg.debugTapProviderTraffic) {
    logger.info(`[ecoclaw] Provider interception enabled. tap=${cfg.debugTapPath}`);
  } else {
    logger.debug(`[ecoclaw] Provider interception enabled. tap=${cfg.debugTapPath}`);
  }
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = toJsonSafe(v, seen);
    }
    seen.delete(obj);
    return out;
  }
  return String(value);
}

async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(toJsonSafe(payload))}\n`, "utf8");
}

function resolveLlmHookTapPath(debugTapPath: string): string {
  if (debugTapPath.endsWith(".jsonl")) {
    return debugTapPath.slice(0, -".jsonl".length) + ".llm-hooks.jsonl";
  }
  return `${debugTapPath}.llm-hooks.jsonl`;
}

function resolveShadowRuntimeTapPath(stateDir: string): string {
  return join(stateDir, "ecoclaw", "shadow-runtime.jsonl");
}

function installLlmHookTap(
  api: any,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
): void {
  if (!cfg.debugTapProviderTraffic) return;
  const llmHookTapPath = resolveLlmHookTapPath(cfg.debugTapPath);
  const hookNames = [
    "before_prompt_build",
    "before_agent_start",
    "llm_input",
    "llm_output",
    "session_start",
    "session_end",
    "before_reset",
    "agent_end",
  ];
  for (const hookName of hookNames) {
    hookOn(api, hookName, async (event: any) => {
      try {
        const turnObservations = extractTurnObservations(event);
        const rec = {
          at: new Date().toISOString(),
          hook: hookName,
          sessionKey: extractSessionKey(event),
          derived: {
            lastUserMessage: extractLastUserMessage(event),
            turnObservationCount: turnObservations.length,
            turnObservations,
          },
          event,
        };
        await appendJsonl(llmHookTapPath, rec);
      } catch (err) {
        logger.warn(
          `[ecoclaw] llm-hook tap write failed(${hookName}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
  logger.info(`[ecoclaw] LLM hook tap enabled. path=${llmHookTapPath}`);
}

async function purgeTaskCacheWorkspace(stateDir: string, taskId: string): Promise<{ purged: string[] }> {
  const sessionsDir = join(stateDir, "ecoclaw", "sessions");
  const targetPrefix = `ecoclaw-task-${safeId(taskId)}-s`;
  let entries: Array<{ isDirectory: () => boolean; name: string }>;
  try {
    entries = (await readdir(sessionsDir, { withFileTypes: true, encoding: "utf8" })) as Array<{
      isDirectory: () => boolean;
      name: string;
    }>;
  } catch {
    return { purged: [] };
  }

  const purged: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(targetPrefix)) continue;
    const fullPath = join(sessionsDir, entry.name);
    await rm(fullPath, { recursive: true, force: true });
    purged.push(fullPath);
  }
  return { purged };
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

function maybeRegisterProxyProvider(
  api: any,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
  baseUrl: string,
  upstream: UpstreamConfig,
) {
  if (typeof api.registerProvider !== "function") {
    logger.warn("[ecoclaw] registerProvider not supported by this OpenClaw version.");
    return;
  }

  try {
    const modelIds = upstream.models.map((m) => m.id);
    const modelDefs = upstream.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: "openai-responses",
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    api.registerProvider({
      id: "ecoclaw",
      name: "EcoClaw Router",
      label: "EcoClaw Router",
      api: "openai-responses",
      baseUrl,
      apiKey: cfg.proxyApiKey ?? "ecoclaw-local",
      authHeader: false,
      models: modelIds.length > 0 ? modelDefs : ["gpt-5.4"],
    });
    logger.info(
      `[ecoclaw] Registered provider ecoclaw/* via embedded proxy. mirrored=${modelIds.slice(0, 6).join(",")}${modelIds.length > 6 ? "..." : ""}`,
    );
  } catch (err: unknown) {
    logger.error(`[ecoclaw] Failed to register provider: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function extractSessionKey(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  const direct =
    event?.sessionKey ??
    event?.SessionKey ??
    event?.result?.sessionKey ??
    event?.result?.SessionKey ??
    event?.meta?.sessionKey ??
    event?.meta?.SessionKey ??
    event?.ctx?.SessionKey ??
    event?.ctx?.CommandTargetSessionKey ??
    event?.session?.key ??
    event?.sessionId ??
    event?.result?.sessionId ??
    agentMeta?.sessionKey ??
    agentMeta?.sessionId ??
    "";
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();

  const channel = String(event?.channel ?? event?.from?.channel ?? "unknown").trim();
  const channelId = String(event?.channelId ?? event?.to?.id ?? event?.conversationId ?? "").trim();
  const threadId = String(event?.messageThreadId ?? event?.threadId ?? "").trim();
  const senderId = String(event?.senderId ?? event?.from?.id ?? "").trim();
  const scoped = [channel, channelId, threadId, senderId].filter((x) => x.length > 0);
  if (scoped.length > 0) return `scoped:${scoped.join(":")}`;

  return "unknown";
}

function extractOpenClawSessionId(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  const direct =
    event?.sessionId ??
    event?.SessionId ??
    event?.ctx?.SessionId ??
    event?.result?.sessionId ??
    event?.result?.SessionId ??
    event?.meta?.sessionId ??
    event?.meta?.SessionId ??
    event?.session?.id ??
    agentMeta?.sessionId ??
    "";
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  return "";
}

function contentToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => contentToText(item))
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "thinking" || obj.type === "reasoning") {
      return "";
    }
    if (obj.type === "output_text" && typeof obj.text === "string") {
      return obj.text;
    }
    const preferred = obj.text ?? obj.content ?? obj.value ?? obj.message;
    if (preferred !== undefined) {
      const nested = contentToText(preferred);
      if (nested.trim().length > 0) return nested;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }
  return String(value);
}

function extractResponseTextFromProviderNode(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return contentToText(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractResponseTextFromProviderNode(item))
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    const role = String(obj.role ?? "").toLowerCase();
    if (type === "output_text" && typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.delta === "string" && obj.delta.trim().length > 0) {
      return obj.delta;
    }
    if (type === "message" || role === "assistant") {
      return extractResponseTextFromProviderNode(obj.content ?? obj.output ?? obj.text);
    }
    return extractResponseTextFromProviderNode(
      obj.response ?? obj.output ?? obj.item ?? obj.content ?? obj.text ?? obj.message,
    );
  }
  return "";
}

function extractProviderResponseText(rawText: string, parsed?: unknown): string {
  const parsedRecord = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const parsedType = String(parsedRecord?.type ?? "").toLowerCase();
  const fromParsed =
    parsedType === "response.created"
      ? ""
      : extractResponseTextFromProviderNode(parsed);
  if (fromParsed.trim().length > 0) return fromParsed.trim();

  let deltaText = "";
  const lines = String(rawText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    try {
      const record = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      const type = String(record.type ?? "").toLowerCase();
      if (type === "response.created") continue;
      const fromRecord = extractResponseTextFromProviderNode(
        record.response ?? record.output ?? record.item ?? record,
      );
      if (fromRecord.trim().length > 0) return fromRecord.trim();
      if (typeof record.delta === "string") {
        deltaText += record.delta;
      }
    } catch {
      // ignore malformed stream fragments
    }
  }
  return deltaText.trim();
}

function extractLastUserMessage(event: any): string {
  const promptText = typeof event?.prompt === "string" ? event.prompt.trim() : "";
  if (promptText) return promptText;
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
  return contentToText(lastUser?.content ?? event?.message?.content ?? event?.message ?? "");
}

function extractLastAssistant(event: any): any {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const fromMessages = [...messages].reverse().find((m: any) => m?.role === "assistant");
  if (fromMessages) return fromMessages;

  const payloads = Array.isArray(event?.result?.payloads) ? event.result.payloads : [];
  if (payloads.length === 0) return null;
  const payloadText = payloads
    .map((payload: any) => contentToText(payload?.text ?? payload?.content ?? payload))
    .filter((s: string) => s.trim().length > 0)
    .join("\n");
  const lastPayload = payloads[payloads.length - 1];

  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta ?? {};
  const usage = agentMeta?.lastCallUsage ?? agentMeta?.usage ?? event?.usage ?? {};
  return {
    role: "assistant",
    content: payloadText || contentToText(lastPayload?.text ?? lastPayload?.content ?? ""),
    provider: agentMeta?.provider ?? event?.provider,
    model: agentMeta?.model ?? event?.model,
    usage,
  };
}

type StructuredTurnObservation = {
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
};

function inferObservationPayloadKind(
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

function extractTurnObservations(event: any): StructuredTurnObservation[] {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const out: StructuredTurnObservation[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const role = String(msg?.role ?? "").toLowerCase();
    if (role !== "tool" && role !== "observation") continue;
    const text = contentToText(msg?.content ?? msg?.text ?? "").trim();
    if (!text) continue;
    const payloadKind = inferObservationPayloadKind(
      text,
      msg?.payloadKind ?? msg?.kind ?? msg?.type,
    );
    const toolName =
      typeof msg?.name === "string" && msg.name.trim().length > 0
        ? msg.name.trim()
        : typeof msg?.tool_name === "string" && msg.tool_name.trim().length > 0
          ? msg.tool_name.trim()
          : typeof msg?.toolName === "string" && msg.toolName.trim().length > 0
            ? msg.toolName.trim()
            : undefined;
    out.push({
      id:
        typeof msg?.tool_call_id === "string" && msg.tool_call_id.trim().length > 0
          ? msg.tool_call_id.trim()
          : `msg-${i + 1}`,
      role: role === "tool" ? "tool" : "observation",
      text,
      payloadKind,
      toolName,
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
    });
  }
  return out;
}

async function buildPromptRootFromSystemPromptReport(report: any): Promise<string> {
  if (!report || typeof report !== "object") return "";
  const files = Array.isArray(report.injectedWorkspaceFiles) ? report.injectedWorkspaceFiles : [];
  const header: string[] = [
    "# OpenClaw Root Prompt (reconstructed)",
    `provider/model: ${String(report.provider ?? "-")}/${String(report.model ?? "-")}`,
    `workspace: ${String(report.workspaceDir ?? "-")}`,
    "",
    "## Context Weight (from systemPromptReport)",
    `- total chars: ${String(report.systemPrompt?.chars ?? "-")}`,
    `- project-context chars: ${String(report.systemPrompt?.projectContextChars ?? "-")}`,
    `- non-project chars: ${String(report.systemPrompt?.nonProjectContextChars ?? "-")}`,
    "",
    "## Skills Snapshot",
  ];
  const skillEntries = Array.isArray(report.skills?.entries) ? report.skills.entries : [];
  if (skillEntries.length === 0) {
    header.push("- (none)");
  } else {
    for (const s of skillEntries) {
      header.push(`- ${String(s?.name ?? "(unknown)")} (${String(s?.blockChars ?? 0)} chars)`);
    }
  }
  header.push("", "## Tools Snapshot");
  const toolEntries = Array.isArray(report.tools?.entries) ? report.tools.entries : [];
  if (toolEntries.length === 0) {
    header.push("- (none)");
  } else {
    for (const t of toolEntries) {
      header.push(`- ${String(t?.name ?? "(unknown)")} (summary=${String(t?.summaryChars ?? 0)}, schema=${String(t?.schemaChars ?? 0)})`);
    }
  }
  header.push("", "## Project Context");
  const blocks: string[] = [];
  for (const file of files) {
    const name = String(file?.name ?? "UNKNOWN");
    const path = String(file?.path ?? "");
    const missing = Boolean(file?.missing);
    if (!path || missing) {
      blocks.push(`[${name}] (missing)`);
      continue;
    }
    try {
      const content = await readFile(path, "utf8");
      blocks.push(`[${name}]\n${content}`);
    } catch {
      blocks.push(`[${name}] (read-failed: ${path})`);
    }
  }
  return [...header, ...blocks].join("\n\n");
}

async function extractOpenClawPromptRoot(event: any): Promise<string> {
  const msgs = Array.isArray(event?.messages) ? event.messages : [];
  const systemTexts = msgs
    .filter((m: any) => String(m?.role ?? "").toLowerCase() === "system")
    .map((m: any) => contentToText(m?.content))
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
  if (systemTexts.length > 0) {
    return systemTexts.join("\n\n");
  }

  const report =
    event?.result?.meta?.systemPromptReport ??
    event?.meta?.systemPromptReport ??
    event?.systemPromptReport;
  const fromReport = await buildPromptRootFromSystemPromptReport(report);
  if (fromReport) return fromReport;

  // Last fallback: reconstruct from default OpenClaw workspace files.
  const workspaceFiles = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md"];
  const blocks: string[] = ["# OpenClaw Root Prompt (fallback workspace reconstruction)"];
  for (const name of workspaceFiles) {
    const path = join(homedir(), ".openclaw", "workspace", name);
    try {
      const text = await readFile(path, "utf8");
      blocks.push(`[${name}]\n${text}`);
    } catch {
      blocks.push(`[${name}] (missing)`);
    }
  }
  return blocks.join("\n\n");
}

function extractTurnTools(event: any): string[] {
  return extractTurnObservations(event)
    .filter((item) => item.role === "tool")
    .map((item) => item.text);
}

function normalizeShadowProvider(provider: unknown, model: unknown): "openai" | "anthropic" {
  const providerText = String(provider ?? "").toLowerCase();
  const modelText = String(model ?? "").toLowerCase();
  if (
    providerText.includes("anthropic") ||
    providerText.includes("claude") ||
    modelText.includes("claude")
  ) {
    return "anthropic";
  }
  return "openai";
}

type ShadowConnector = ReturnType<typeof createOpenClawConnector>;

function createShadowRuntimeConnector(cfg: ReturnType<typeof normalizeConfig>): ShadowConnector {
  const semanticEmbedding = cfg.semanticReduction.embedding ?? {
    provider: "none" as const,
    requestTimeoutMs: 30000,
  };
  return createOpenClawConnector({
    modules: [
      createStabilizerModule(),
      createPolicyModule({
        summaryGenerationMode: cfg.compaction.summaryGenerationMode,
        summaryMaxOutputTokens: cfg.compaction.summaryMaxOutputTokens,
        handoffEnabled: cfg.handoff.enabled,
        handoffGenerationMode: cfg.handoff.handoffGenerationMode,
        handoffMaxOutputTokens: cfg.handoff.handoffMaxOutputTokens,
        handoffCooldownTurns: cfg.handoff.handoffCooldownTurns,
        reductionSemanticEnabled: cfg.semanticReduction.enabled,
        reductionSemanticMinChars: cfg.semanticReduction.minInputChars,
        compactionEnabled: cfg.compaction.enabled,
        compactionCooldownTurns: cfg.compaction.compactionCooldownTurns,
      }),
      createContextStateModule({ maxSummaryChars: 2400 }),
      createCompactionModule({
        generationMode: cfg.compaction.summaryGenerationMode,
        fallbackToHeuristic: cfg.compaction.summaryFallbackToHeuristic,
        compactionMaxOutputTokens: cfg.compaction.summaryMaxOutputTokens,
        includeAssistantReply: cfg.compaction.includeAssistantReply,
        compactionPrompt: cfg.compaction.summaryPrompt,
        compactionPromptPath: cfg.compaction.summaryPromptPath,
        resumePrefixPrompt: cfg.compaction.resumePrefixPrompt,
        resumePrefixPromptPath: cfg.compaction.resumePrefixPromptPath,
      }),
      createSummaryModule({
        generationMode: cfg.compaction.summaryGenerationMode,
        fallbackToHeuristic: cfg.compaction.summaryFallbackToHeuristic,
        summaryMaxOutputTokens: cfg.compaction.summaryMaxOutputTokens,
        includeAssistantReply: cfg.compaction.includeAssistantReply,
      }),
      createHandoffModule({
        generationMode: cfg.handoff.handoffGenerationMode,
        fallbackToHeuristic: cfg.handoff.handoffFallbackToHeuristic,
        handoffMaxOutputTokens: cfg.handoff.handoffMaxOutputTokens,
        includeAssistantReply: cfg.handoff.includeAssistantReply,
        handoffPrompt: cfg.handoff.handoffPrompt,
        handoffPromptPath: cfg.handoff.handoffPromptPath,
        triggerEventType: ECOCLAW_EVENT_TYPES.POLICY_HANDOFF_REQUESTED,
      }),
      createReductionModule({
        semanticLlmlingua2: {
          enabled: cfg.semanticReduction.enabled,
          pythonBin: cfg.semanticReduction.pythonBin,
          timeoutMs: cfg.semanticReduction.timeoutMs,
          modelPath: cfg.semanticReduction.llmlinguaModelPath,
          targetRatio: cfg.semanticReduction.targetRatio,
          minInputChars: cfg.semanticReduction.minInputChars,
          minSavedChars: cfg.semanticReduction.minSavedChars,
          preselectRatio: cfg.semanticReduction.preselectRatio,
          maxChunkChars: cfg.semanticReduction.maxChunkChars,
          embedding: {
            provider: semanticEmbedding.provider,
            modelPath: semanticEmbedding.modelPath,
            apiBaseUrl: semanticEmbedding.apiBaseUrl,
            apiKey: semanticEmbedding.apiKey,
            apiModel: semanticEmbedding.apiModel,
            requestTimeoutMs: semanticEmbedding.requestTimeoutMs,
          },
        },
      }),
      createDecisionLedgerModule(),
    ],
    adapters: {
      openai: openaiAdapter,
      anthropic: anthropicAdapter,
    },
    stateDir: cfg.stateDir,
    routing: {
      autoForkOnPolicy: cfg.compaction.autoForkOnPolicy,
      physicalSessionPrefix: "shadow",
    },
    observability: {
      eventTracePath: join(cfg.stateDir, "ecoclaw", "event-trace.jsonl"),
    },
  });
}

async function buildShadowTurnContext(
  event: any,
  topology: SessionTopologyManager,
  sessionHint?: { sessionKey?: string; upstreamSessionId?: string } | null,
): Promise<RuntimeTurnContext | null> {
  const sessionKey =
    String(sessionHint?.sessionKey ?? "").trim() || extractSessionKey(event);
  const upstreamSessionId =
    String(sessionHint?.upstreamSessionId ?? "").trim() ||
    extractOpenClawSessionId(event) ||
    topology.getUpstreamSessionId(sessionKey) ||
    sessionKey;
  const userMessage = normalizeUserMessageText(extractLastUserMessage(event).trim());
  if (!userMessage) return null;
  const cmd = parseEcoClawCommand(userMessage);
  if (cmd.kind !== "none") return null;

  const lastAssistant = extractLastAssistant(event);
  const provider = normalizeShadowProvider(
    lastAssistant?.provider ?? event?.provider,
    lastAssistant?.model ?? event?.model,
  );
  const model = String(lastAssistant?.model ?? event?.model ?? "unknown").trim() || "unknown";
  const logicalSessionId = topology.getLogicalSessionId(sessionKey, upstreamSessionId);
  const promptRoot = await extractOpenClawPromptRoot(event);
  const turnObservations = extractTurnObservations(event);
  const turnTools = turnObservations
    .filter((item) => item.role === "tool")
    .map((item) => item.text);

  return {
    sessionId: logicalSessionId,
    sessionMode: "single",
    provider,
    model,
    prompt: userMessage,
    segments: [
      ...(promptRoot
        ? [
            {
              id: "openclaw-root-prompt",
              kind: "stable" as const,
              text: promptRoot,
              priority: 1,
              source: "openclaw.system_prompt",
            },
          ]
        : []),
      {
        id: "latest-user-turn",
        kind: "volatile" as const,
        text: userMessage,
        priority: 10,
        source: "openclaw.user_turn",
      },
    ],
    budget: {
      maxInputTokens: 400000,
      reserveOutputTokens: 16000,
    },
    metadata: {
      sessionKey,
      logicalSessionId,
      openclawSessionId: upstreamSessionId,
      openclawPromptRoot: promptRoot,
      turnTools,
      turnObservations,
      shadowRuntime: {
        source: "openclaw-plugin.agent_end",
        observationCount: turnObservations.length,
      },
    },
  };
}

function buildShadowTurnResult(event: any): RuntimeTurnResult | null {
  const lastAssistant = extractLastAssistant(event);
  const content = contentToText(lastAssistant?.content ?? "").trim();
  if (!content) return null;
  const rawUsage = lastAssistant?.usage ?? event?.usage ?? undefined;
  return {
    content,
    usage: rawUsage === undefined ? undefined : { providerRaw: rawUsage },
    metadata: {
      shadowRuntime: {
        source: "openclaw-plugin.agent_end",
      },
    },
  };
}

function registerEcoClawCommand(
  api: any,
  logger: Required<PluginLogger>,
  topology: SessionTopologyManager,
  cfg: ReturnType<typeof normalizeConfig>,
): void {
  if (typeof api.registerCommand !== "function") {
    logger.debug("[ecoclaw] registerCommand unavailable, fallback to inline command parsing.");
    return;
  }

  const handler = async (ctxOrRaw?: any, legacyContext?: any) => {
    const args =
      typeof ctxOrRaw === "string"
        ? ctxOrRaw
        : typeof ctxOrRaw?.args === "string"
          ? ctxOrRaw.args
          : "";
    const context = legacyContext ?? ctxOrRaw ?? {};
    const cmd = parseEcoClawCommand(`ecoclaw ${String(args).trim()}`.trim());
    const sessionKey = extractSessionKey(context) || "unknown";
    logger.info(
      `[ecoclaw] command invoked kind=${cmd.kind} args="${String(args ?? "").trim()}" session=${sessionKey}`,
    );
    if (cmd.kind === "status") {
      return { text: topology.getStatus(sessionKey) };
    }
    if (cmd.kind === "cache_new") {
      const logical = topology.newTaskCache(sessionKey, cmd.taskId);
      return {
        text:
          `Created task-cache and switched current binding.\n${topology.getStatus(sessionKey)}\nlogical=${logical}\n\n` +
          `Reminder: this switches EcoClaw task-cache only.\n` +
          `If you want a truly clean upstream OpenClaw context, run /new now.`,
      };
    }
    if (cmd.kind === "cache_list") {
      return { text: topology.listTaskCaches(sessionKey) };
    }
    if (cmd.kind === "cache_delete") {
      const removed = topology.deleteTaskCache(sessionKey, cmd.taskId);
      if (!removed) {
        return { text: `No matching task-cache found for ${cmd.taskId ? `"${safeId(cmd.taskId)}"` : "current binding"}.` };
      }
      const purge = await purgeTaskCacheWorkspace(cfg.stateDir, removed.removedTaskId);
      return {
        text: `Deleted task-cache "${removed.removedTaskId}" (bindings=${removed.removedBindings}, purged=${purge.purged.length}).\n${topology.getStatus(sessionKey)}\nlogical=${removed.switchedToLogical}`,
      };
    }
    if (cmd.kind === "session_new") {
      const logical = topology.newSession(sessionKey);
      return { text: `Created new session in current task-cache.\n${topology.getStatus(sessionKey)}\nlogical=${logical}` };
    }
    return { text: commandHelpText() };
  };

  api.registerCommand({
    name: "ecoclaw",
    description: "EcoClaw task-cache/session controls (try: /ecoclaw help)",
    acceptsArgs: true,
    handler,
    execute: handler,
  });
  logger.debug("[ecoclaw] Registered /ecoclaw command.");
}

module.exports = {
  id: "ecoclaw",
  name: "EcoClaw Runtime Optimizer",

  register(api: any) {
    const logger = makeLogger(api?.logger);
    const cfg = normalizeConfig(api?.pluginConfig);
    const debugEnabled = cfg.logLevel === "debug";
    const shadowConnector = createShadowRuntimeConnector(cfg);

    if (!cfg.enabled) {
      logger.info("[ecoclaw] Plugin disabled by config.");
      return;
    }

    const topology = createSessionTopologyManager();
    const recentTurnBindings: Array<{
      userMessage: string;
      matchKey: string;
      sessionKey: string;
      upstreamSessionId?: string;
      at: number;
    }> = [];
    const rememberTurnBinding = (userMessage: string, sessionKey: string, upstreamSessionId?: string) => {
      const normalizedMessage = String(userMessage ?? "").trim();
      const matchKey = normalizeTurnBindingMessage(normalizedMessage);
      const normalizedSessionKey = String(sessionKey ?? "").trim();
      if (!normalizedMessage || !matchKey || !normalizedSessionKey) return;
      recentTurnBindings.push({
        userMessage: normalizedMessage,
        matchKey,
        sessionKey: normalizedSessionKey,
        upstreamSessionId: String(upstreamSessionId ?? "").trim() || undefined,
        at: Date.now(),
      });
      while (recentTurnBindings.length > 128) recentTurnBindings.shift();
      if (cfg.stateDir) {
        persistRecentTurnBindingsToState(cfg.stateDir, recentTurnBindings);
      }
    };
    const resolveTurnBinding = (userMessage: string) => {
      const normalizedMessage = normalizeTurnBindingMessage(String(userMessage ?? "").trim());
      if (!normalizedMessage) return null;
      const persistedCandidates = cfg.stateDir ? loadRecentTurnBindingsFromState(cfg.stateDir) : [];
      const candidates = [...recentTurnBindings, ...persistedCandidates];
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const candidate = candidates[i];
        if (candidate.matchKey !== normalizedMessage) continue;
        if (Date.now() - candidate.at > 30 * 60 * 1000) continue;
        return candidate;
      }
      return null;
    };
    let proxyRuntime: Awaited<ReturnType<typeof startEmbeddedResponsesProxy>> | null = null;
    let proxyInitDone = false;
    let proxyInitPromise: Promise<void> | null = null;

    const ensureProxyReady = async (): Promise<void> => {
      if (proxyInitDone) return;
      if (proxyInitPromise) return proxyInitPromise;
      proxyInitPromise = (async () => {
        const g = globalThis as any;
        const existing = g.__ecoclaw_embedded_proxy_runtime__;
        if (existing && existing.baseUrl && existing.upstream) {
          proxyRuntime = existing;
          proxyInitDone = true;
          return;
        }
        proxyRuntime = await startEmbeddedResponsesProxy(
          cfg,
          logger,
          topology,
          resolveTurnBinding,
        );
        if (!proxyRuntime) return;
        g.__ecoclaw_embedded_proxy_runtime__ = proxyRuntime;
        maybeRegisterProxyProvider(api, cfg, logger, proxyRuntime.baseUrl, proxyRuntime.upstream);
        await ensureExplicitProxyModelsInConfig(proxyRuntime.baseUrl, proxyRuntime.upstream, logger);
        proxyInitDone = true;
      })().catch((err) => {
        logger.warn(`[ecoclaw] embedded proxy init failed: ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => {
        proxyInitPromise = null;
      });
      return proxyInitPromise;
    };

    maybeInstallProviderTrafficTap(cfg, logger, topology, resolveTurnBinding);
    installLlmHookTap(api, cfg, logger);
    registerEcoClawCommand(api, logger, topology, cfg);
    hookOn(api, "session_start", (event: any) => {
      const sessionKey = extractSessionKey(event);
      const upstreamSessionId = extractOpenClawSessionId(event);
      if (!sessionKey || !upstreamSessionId) return;
      topology.bindUpstreamSession(sessionKey, upstreamSessionId);
      if (debugEnabled) {
        logger.debug(
          `[ecoclaw] session_start synced sessionKey=${sessionKey} openclawSessionId=${upstreamSessionId} ${topology.getStatus(sessionKey)}`,
        );
      }
    });
    hookOn(api, "message_received", (event: any) => {
      const sessionKey = extractSessionKey(event);
      const upstreamSessionId =
        extractOpenClawSessionId(event) || topology.getUpstreamSessionId(sessionKey) || undefined;
      const userMessage = extractLastUserMessage(event);
      if (userMessage.trim()) {
        rememberTurnBinding(userMessage, sessionKey, upstreamSessionId);
      }
      const cmd = parseEcoClawCommand(userMessage);
      if (cmd.kind !== "none") {
        if (cmd.kind === "status") {
          logger.info(`[ecoclaw] ${topology.getStatus(sessionKey)}`);
        } else if (cmd.kind === "cache_new") {
          const logical = topology.newTaskCache(sessionKey, cmd.taskId);
          logger.info(`[ecoclaw] cache new -> ${topology.getStatus(sessionKey)} logical=${logical}`);
        } else if (cmd.kind === "cache_delete") {
          const removed = topology.deleteTaskCache(sessionKey, cmd.taskId);
          if (!removed) {
            logger.info(
              `[ecoclaw] cache delete -> no matching task-cache for ${cmd.taskId ? safeId(cmd.taskId) : "current"}`,
            );
          } else {
            void purgeTaskCacheWorkspace(cfg.stateDir, removed.removedTaskId)
              .then((purge) => {
                logger.info(
                  `[ecoclaw] cache delete -> removed=${removed.removedTaskId} bindings=${removed.removedBindings} purged=${purge.purged.length} now=${topology.getStatus(sessionKey)} logical=${removed.switchedToLogical}`,
                );
              })
              .catch((err) => {
                logger.warn(
                  `[ecoclaw] cache delete purge failed for ${removed.removedTaskId}: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          }
        } else if (cmd.kind === "session_new") {
          const logical = topology.newSession(sessionKey);
          logger.info(
            `[ecoclaw] session new -> ${topology.getStatus(sessionKey)} logical=${logical}`,
          );
        } else if (cmd.kind === "openclaw_session_new") {
          logger.info(
            `[ecoclaw] observed native /new on ${sessionKey}; waiting for OpenClaw session_start to publish the new sessionId`,
          );
        } else {
          logger.info(`[ecoclaw] ${commandHelpText().replace(/\n/g, " | ")}`);
        }
      }
      if (!debugEnabled) return;
      logger.debug(`[ecoclaw] message_received session=${sessionKey}`);
    });
    hookOn(api, "llm_input", (event: any) => {
      const userMessage = extractLastUserMessage(event);
      const upstreamSessionId = extractOpenClawSessionId(event);
      const sessionKey = upstreamSessionId || extractSessionKey(event);
      if (userMessage.trim() && sessionKey.trim()) {
        rememberTurnBinding(userMessage, sessionKey, upstreamSessionId || undefined);
        if (upstreamSessionId) {
          topology.bindUpstreamSession(sessionKey, upstreamSessionId);
        }
      }
      if (!debugEnabled) return;
      logger.debug(
        `[ecoclaw] llm_input prompt-bound session=${sessionKey || "unknown"} openclawSessionId=${upstreamSessionId || "-"}`,
      );
    });

    hookOn(api, "agent_end", async (event: any) => {
      const sessionKey = extractSessionKey(event);
      const lastAssistant = extractLastAssistant(event);
      const turnObservations = extractTurnObservations(event);
      const model = lastAssistant?.model ?? event?.model ?? "unknown";
      const provider = lastAssistant?.provider ?? event?.provider ?? "unknown";
      if (debugEnabled) {
        logger.debug(
          `[ecoclaw] agent_end session=${sessionKey} provider=${provider} model=${model} observations=${turnObservations.length}`,
        );
      }
      try {
        const sessionHint = resolveTurnBinding(extractLastUserMessage(event));
        const turnCtx = await buildShadowTurnContext(event, topology, sessionHint);
        const turnResult = buildShadowTurnResult(event);
        if (!turnCtx || !turnResult) {
          if (debugEnabled || cfg.debugTapProviderTraffic) {
            await appendJsonl(resolveShadowRuntimeTapPath(cfg.stateDir), {
              at: new Date().toISOString(),
              stage: "shadow_runtime_skipped",
              sessionKey,
              provider,
              model,
              hasTurnContext: Boolean(turnCtx),
              hasTurnResult: Boolean(turnResult),
              userMessageChars: extractLastUserMessage(event).trim().length,
              assistantChars: contentToText(lastAssistant?.content ?? "").trim().length,
              observationCount: turnObservations.length,
            });
          }
          return;
        }
        if (debugEnabled || cfg.debugTapProviderTraffic) {
          await appendJsonl(resolveShadowRuntimeTapPath(cfg.stateDir), {
            at: new Date().toISOString(),
            stage: "shadow_runtime_start",
            sessionKey,
            logicalSessionId:
              (turnCtx.metadata as Record<string, unknown> | undefined)?.logicalSessionId ?? turnCtx.sessionId,
            provider: turnCtx.provider,
            model: turnCtx.model,
            segmentCount: turnCtx.segments.length,
            observationCount: turnObservations.length,
            promptChars: turnCtx.prompt.length,
            responseChars: turnResult.content.length,
          });
        }
        if (turnCtx && turnResult) {
          await shadowConnector.onLlmCall(turnCtx, async () => turnResult);
          if (debugEnabled || cfg.debugTapProviderTraffic) {
            await appendJsonl(resolveShadowRuntimeTapPath(cfg.stateDir), {
              at: new Date().toISOString(),
              stage: "shadow_runtime_ok",
              sessionKey,
              logicalSessionId:
                (turnCtx.metadata as Record<string, unknown> | undefined)?.logicalSessionId ?? turnCtx.sessionId,
              provider: turnCtx.provider,
              model: turnCtx.model,
            });
          }
        }
      } catch (err) {
        if (debugEnabled || cfg.debugTapProviderTraffic) {
          await appendJsonl(resolveShadowRuntimeTapPath(cfg.stateDir), {
            at: new Date().toISOString(),
            stage: "shadow_runtime_error",
            sessionKey,
            provider,
            model,
            observationCount: turnObservations.length,
            error: err instanceof Error
              ? {
                  name: err.name,
                  message: err.message,
                  stack: err.stack,
                }
              : String(err),
          });
        }
        logger.warn(
          `[ecoclaw] shadow runtime turn failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    });

    if (typeof api.registerService === "function") {
      api.registerService({
        id: "ecoclaw-runtime",
        start: () => {
          void ensureProxyReady();
          logger.info("[ecoclaw] Plugin active.");
          if (proxyRuntime?.baseUrl) {
            logger.info(`[ecoclaw] Embedded proxy active at ${proxyRuntime.baseUrl}`);
          } else {
            logger.info("[ecoclaw] Embedded proxy unavailable; ecoclaw provider was not registered.");
          }
          logger.info("[ecoclaw] Use explicit model key: ecoclaw/<model> (example: ecoclaw/gpt-5.4).");
          logger.info(`[ecoclaw] State dir=${cfg.stateDir} debugTap=${cfg.debugTapProviderTraffic ? "on" : "off"}`);
        },
        stop: () => {
          if (proxyRuntime) {
            void proxyRuntime.close().catch((err) => {
              logger.warn(
                `[ecoclaw] embedded proxy stop failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
            const g = globalThis as any;
            if (g.__ecoclaw_embedded_proxy_runtime__ === proxyRuntime) {
              delete g.__ecoclaw_embedded_proxy_runtime__;
            }
            proxyRuntime = null;
            proxyInitDone = false;
          }
          logger.info("[ecoclaw] Plugin stopped.");
        },
      });
    }
  },
};
