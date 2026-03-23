/* eslint-disable @typescript-eslint/no-explicit-any */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readdir, rm } from "node:fs/promises";
import { readFile, mkdir, appendFile, writeFile } from "node:fs/promises";
import { createOpenClawConnector } from "@ecoclaw/layer-orchestration";
import {
  createCacheModule,
  createCompactionTriggerModule,
  createSummaryModule,
  createCompressionModule,
} from "@ecoclaw/layer-execution";
import { createPolicyModule, createDecisionLedgerModule } from "@ecoclaw/layer-decision";
import { createMemoryStateModule } from "@ecoclaw/layer-data";
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
  cacheProbeEnabled?: boolean;
  cacheProbeIntervalSeconds?: number;
  cacheProbeMaxPromptChars?: number;
  cacheProbeHitMinTokens?: number;
  cacheProbeMissesToCold?: number;
  cacheProbeWarmSeconds?: number;
  compactionTriggerEnabled?: boolean;
  compactionTriggerInputTokens?: number;
  compactionTriggerTurnCount?: number;
  compactionTriggerMissRateThreshold?: number;
  compactionTriggerWindowTurns?: number;
  compactionTriggerCooldownTurns?: number;
  debugTapProviderTraffic?: boolean;
  debugTapPath?: string;
  responseRootLinkEnabled?: boolean;
  responseRootMinInstructionChars?: number;
  responseRootPrefixMaxChars?: number;
  responseRootMatchMinRatio?: number;
  responseRootPrimeEnabled?: boolean;
  proxyAutostart?: boolean;
  proxyPort?: number;
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
  getLogicalSessionId(sessionKey: string): string;
  getStatus(sessionKey: string): string;
  listTaskCaches(sessionKey: string): string;
  newTaskCache(sessionKey: string, taskId?: string): string;
  newSession(sessionKey: string): string;
  deleteTaskCache(sessionKey: string, taskId?: string): {
    removedTaskId: string;
    removedBindings: number;
    switchedToLogical: string;
  } | null;
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
    getLogicalSessionId(sessionKey: string): string {
      const b = ensure(sessionKey);
      return buildLogicalSessionId(b.taskId, b.sessionSeq);
    },
    getStatus(sessionKey: string): string {
      const b = ensure(sessionKey);
      return `sessionKey=${sessionKey} task=${b.taskId} logical=${buildLogicalSessionId(b.taskId, b.sessionSeq)} seq=${b.sessionSeq}`;
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
  kind: "none" | "status" | "cache_new" | "cache_delete" | "cache_list" | "session_new" | "help";
  taskId?: string;
};

function parseEcoClawCommand(raw: string): EcoClawCmd {
  const text = raw.trim();
  if (!text) return { kind: "none" };
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
    summaryTriggerInputTokens: Math.max(0, cfg.summaryTriggerInputTokens ?? 200000),
    summaryTriggerStableChars: Math.max(0, cfg.summaryTriggerStableChars ?? 0),
    summaryRecentTurns: Math.max(1, cfg.summaryRecentTurns ?? 8),
    maxSummaryChars: Math.max(200, cfg.maxSummaryChars ?? 6000),
    compactionPrompt: cfg.compactionPrompt ?? "",
    resumePrefixPrompt: cfg.resumePrefixPrompt ?? "",
    cacheProbeEnabled: cfg.cacheProbeEnabled ?? true,
    cacheProbeIntervalSeconds: Math.max(30, cfg.cacheProbeIntervalSeconds ?? 1800),
    cacheProbeMaxPromptChars: Math.max(1, cfg.cacheProbeMaxPromptChars ?? 120),
    cacheProbeHitMinTokens: Math.max(0, cfg.cacheProbeHitMinTokens ?? 64),
    cacheProbeMissesToCold: Math.max(1, cfg.cacheProbeMissesToCold ?? 2),
    cacheProbeWarmSeconds: Math.max(30, cfg.cacheProbeWarmSeconds ?? 7200),
    compactionTriggerEnabled: cfg.compactionTriggerEnabled ?? true,
    compactionTriggerInputTokens: Math.max(0, cfg.compactionTriggerInputTokens ?? 120000),
    compactionTriggerTurnCount: Math.max(1, cfg.compactionTriggerTurnCount ?? 18),
    compactionTriggerMissRateThreshold: Math.min(1, Math.max(0, cfg.compactionTriggerMissRateThreshold ?? 0.7)),
    compactionTriggerWindowTurns: Math.max(3, cfg.compactionTriggerWindowTurns ?? 8),
    compactionTriggerCooldownTurns: Math.max(0, cfg.compactionTriggerCooldownTurns ?? 6),
    debugTapProviderTraffic: cfg.debugTapProviderTraffic ?? false,
    debugTapPath: cfg.debugTapPath ?? join(stateDir, "ecoclaw", "provider-traffic.jsonl"),
    responseRootLinkEnabled: cfg.responseRootLinkEnabled ?? true,
    responseRootMinInstructionChars: Math.max(64, cfg.responseRootMinInstructionChars ?? 1200),
    responseRootPrefixMaxChars: Math.max(128, cfg.responseRootPrefixMaxChars ?? 6000),
    responseRootMatchMinRatio: Math.min(1, Math.max(0.1, cfg.responseRootMatchMinRatio ?? 0.7)),
    responseRootPrimeEnabled: cfg.responseRootPrimeEnabled ?? true,
    proxyAutostart: cfg.proxyAutostart ?? true,
    proxyPort: Math.max(1025, Math.min(65535, cfg.proxyPort ?? 17667)),
  };
}

type ResponseRootState = {
  rootResponseId: string;
  instructionSig: string;
  instructionChars: number;
  prefixSample: string;
  model: string;
  endpoint: string;
  createdAt: string;
  updatedAt: string;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
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

function getDeveloperAndLastUser(input: any): { developerText: string; userItem: any } | null {
  if (!Array.isArray(input) || input.length < 2) return null;
  const first = input[0];
  const last = input[input.length - 1];
  if (!first || typeof first !== "object" || String((first as any).role) !== "developer") return null;
  if (!last || typeof last !== "object" || String((last as any).role) !== "user") return null;
  const developerText =
    typeof (first as any).content === "string"
      ? String((first as any).content)
      : extractInputText([first]);
  if (!developerText.trim()) return null;
  return { developerText, userItem: last };
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

function commonPrefixRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < minLen && a[i] === b[i]) i += 1;
  return i / maxLen;
}

function extractResponseIdFromAnyText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const id = String(parsed?.id ?? "");
    if (id) return id;
  } catch {
    // continue to regex extraction
  }
  const m = text.match(/"id"\s*:\s*"(resp_[^"]+)"/);
  return m?.[1] ?? "";
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
): Promise<{ baseUrl: string; upstream: UpstreamConfig; close: () => Promise<void> } | null> {
  if (!cfg.proxyAutostart) return null;
  const upstream = await detectUpstreamConfig(logger);
  if (!upstream) {
    logger.warn("[ecoclaw] no upstream provider discovered; proxy disabled.");
    return null;
  }
  const rootStateBySig = new Map<string, ResponseRootState>();
  const rootStatePath = join(cfg.stateDir, "ecoclaw", "response-root-state.json");
  try {
    const raw = await readFile(rootStatePath, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const s = item as ResponseRootState;
        if (s.instructionSig && s.rootResponseId) rootStateBySig.set(s.instructionSig, s);
      }
    }
  } catch {
    // ignore.
  }

  async function persistRootState(): Promise<void> {
    try {
      await mkdir(dirname(rootStatePath), { recursive: true });
      await writeFile(rootStatePath, JSON.stringify(Array.from(rootStateBySig.values()), null, 2), "utf8");
    } catch (err) {
      logger.warn(`[ecoclaw] persist root state failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      const instructions = normalizeText(String(payload?.instructions ?? ""));
      const inputText = normalizeText(extractInputText(payload?.input));
      const devAndUser = getDeveloperAndLastUser(payload?.input);
      const developerText = normalizeText(devAndUser?.developerText ?? "");
      const sigSource = developerText || instructions;
      const sig = sha256Hex(`${upstream.baseUrl}|${upstreamModel || model}|${sigSource}`);
      const hasPrev = typeof payload?.previous_response_id === "string" && payload.previous_response_id.length > 0;
      logger.info(
        `[ecoclaw] proxy request model=${model || "unknown"} upstreamModel=${upstreamModel || "unknown"} hasPrev=${hasPrev ? "yes" : "no"} instrChars=${instructions.length}`,
      );
      if (cfg.debugTapProviderTraffic) {
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_inbound",
          model,
          upstreamModel,
          hasPrev,
          instructionsChars: instructions.length,
          inputChars: inputText.length,
          devUserDetected: Boolean(devAndUser),
          developerChars: developerText.length,
          rootSig: sig,
          rootStateExistsBefore: rootStateBySig.has(sig),
          rootPrimeEnabled: cfg.responseRootPrimeEnabled,
          payload,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      let injectedFromRoot = false;
      if (cfg.responseRootLinkEnabled && !hasPrev) {
        let state = rootStateBySig.get(sig);
        if (
          !state &&
          cfg.responseRootPrimeEnabled &&
          devAndUser &&
          developerText.length >= cfg.responseRootMinInstructionChars
        ) {
          try {
            const primePayload: any = { ...payload };
            delete primePayload.previous_response_id;
            primePayload.model = upstreamModel || model;
            primePayload.store = true;
            primePayload.input = [{ role: "developer", content: devAndUser.developerText }];
            const primeResp = await fetch(`${upstream.baseUrl}/responses`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${upstream.apiKey}`,
              },
              body: JSON.stringify(primePayload),
            });
            const primeTxt = await primeResp.text();
            const primeId = extractResponseIdFromAnyText(primeTxt);
            if (primeResp.ok && primeId) {
              const nowIso = new Date().toISOString();
              state = {
                rootResponseId: primeId,
                instructionSig: sig,
                instructionChars: sigSource.length,
                prefixSample: sigSource.slice(0, cfg.responseRootPrefixMaxChars),
                model: upstreamModel || model,
                endpoint: upstream.baseUrl,
                createdAt: nowIso,
                updatedAt: nowIso,
              };
              rootStateBySig.set(sig, state);
              void persistRootState();
              logger.info(
                `[ecoclaw] proxy primed root response model=${model} rootId=${primeId.slice(0, 18)}...`,
              );
            }
          } catch (err) {
            logger.warn(
              `[ecoclaw] proxy prime root failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (state?.rootResponseId && devAndUser) {
          payload.previous_response_id = state.rootResponseId;
          payload.input = [devAndUser.userItem];
          injectedFromRoot = true;
          logger.info(`[ecoclaw] proxy injected previous_response_id model=${model} mode=developer-root`);
        } else if (state?.rootResponseId && instructions.length >= cfg.responseRootMinInstructionChars) {
          const ratio = commonPrefixRatio(inputText, state.prefixSample);
          if (ratio >= cfg.responseRootMatchMinRatio) {
            payload.previous_response_id = state.rootResponseId;
            injectedFromRoot = true;
            logger.info(
              `[ecoclaw] proxy injected previous_response_id model=${model} ratio=${ratio.toFixed(2)}`,
            );
          }
        }
      }
      const upstreamResp = await fetch(`${upstream.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${upstream.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      const txt = await upstreamResp.text();
      const responseId = extractResponseIdFromAnyText(txt);
      if (!hasPrev && !injectedFromRoot && responseId && sigSource.length >= cfg.responseRootMinInstructionChars) {
        const nowIso = new Date().toISOString();
        rootStateBySig.set(sig, {
          rootResponseId: responseId,
          instructionSig: sig,
          instructionChars: sigSource.length,
          prefixSample: sigSource.slice(0, cfg.responseRootPrefixMaxChars),
          model: upstreamModel || model,
          endpoint: upstream.baseUrl,
          createdAt: rootStateBySig.get(sig)?.createdAt ?? nowIso,
          updatedAt: nowIso,
        });
        void persistRootState();
      }
      if (cfg.debugTapProviderTraffic) {
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_forwarded",
          model,
          upstreamModel,
          forwardedHasPrev:
            typeof payload?.previous_response_id === "string" && payload.previous_response_id.length > 0,
          forwardedInputCount: Array.isArray(payload?.input) ? payload.input.length : -1,
          forwardedInputRoles: Array.isArray(payload?.input)
            ? payload.input.map((x: any) => String(x?.role ?? ""))
            : [],
          forwardedDeveloperChars:
            Array.isArray(payload?.input) &&
            payload.input.length > 0 &&
            String(payload.input[0]?.role) === "developer" &&
            typeof payload.input[0]?.content === "string"
              ? String(payload.input[0].content).length
              : 0,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      if (cfg.debugTapProviderTraffic) {
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_outbound",
          model,
          upstreamModel,
          status: upstreamResp.status,
          responseId: responseId || null,
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
): void {
  if (!cfg.debugTapProviderTraffic && !cfg.responseRootLinkEnabled) return;
  const g = globalThis as any;
  if (g.__ecoclaw_provider_tap_installed__) return;
  const origFetch = g.fetch;
  if (typeof origFetch !== "function") {
    logger.warn("[ecoclaw] debugTapProviderTraffic requested but global fetch is unavailable.");
    return;
  }
  const rootStateBySig = new Map<string, ResponseRootState>();
  const rootStatePath = join(cfg.stateDir, "ecoclaw", "response-root-state.json");
  let rootStateLoaded = false;

  async function ensureRootStateLoaded(): Promise<void> {
    if (rootStateLoaded) return;
    rootStateLoaded = true;
    try {
      const raw = await readFile(rootStatePath, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (!item || typeof item !== "object") continue;
          const s = item as ResponseRootState;
          if (!s.instructionSig || !s.rootResponseId) continue;
          rootStateBySig.set(s.instructionSig, s);
        }
      }
    } catch {
      // ignore missing/invalid cache file.
    }
  }

  async function persistRootState(): Promise<void> {
    try {
      await mkdir(dirname(rootStatePath), { recursive: true });
      const arr = Array.from(rootStateBySig.values());
      await writeFile(rootStatePath, JSON.stringify(arr, null, 2), "utf8");
    } catch (err) {
      logger.warn(
        `[ecoclaw] root state persist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  g.__ecoclaw_provider_tap_installed__ = true;
  g.fetch = async (input: any, init?: any) => {
    await ensureRootStateLoaded();
    let url = "";
    try {
      url =
        typeof input === "string"
          ? input
          : typeof input?.url === "string"
            ? input.url
            : "";
    } catch {
      url = "";
    }
    const lower = url.toLowerCase();
    const isResponsesCall = lower.includes("/responses");
    const isProviderCall =
      lower.includes("api.openai.com") ||
      lower.includes("api.anthropic.com") ||
      lower.includes("dashscope") ||
      lower.includes("openrouter.ai");

    let reqBody = "";
    let bodySource: "init" | "request" | "none" = "none";
    if (isProviderCall) {
      try {
        if (typeof init?.body === "string") {
          reqBody = init.body;
          bodySource = "init";
        } else if (input && typeof input.clone === "function") {
          const clone = input.clone();
          reqBody = await clone.text();
          bodySource = reqBody ? "request" : "none";
        }
      } catch {
        reqBody = "";
        bodySource = "none";
      }
    }

    let usedRootLink = false;
    let rootSig = "";
    if (cfg.responseRootLinkEnabled && isProviderCall && isResponsesCall && reqBody) {
      try {
        const payload = JSON.parse(reqBody);
        const model = String(payload?.model ?? "");
        const instructions = normalizeText(String(payload?.instructions ?? ""));
        const inputText = normalizeText(extractInputText(payload?.input));
        if (instructions.length >= cfg.responseRootMinInstructionChars && model) {
          rootSig = sha256Hex(`${url}|${model}|${instructions}`);
          const state = rootStateBySig.get(rootSig);
          const hasPrev = typeof payload?.previous_response_id === "string" && payload.previous_response_id.length > 0;
          if (!hasPrev && state?.rootResponseId) {
            const ratio = commonPrefixRatio(inputText, state.prefixSample);
            if (ratio >= cfg.responseRootMatchMinRatio) {
              payload.previous_response_id = state.rootResponseId;
              const nextBody = JSON.stringify(payload);
              if (bodySource === "init") {
                init = { ...(init ?? {}), body: nextBody };
              } else if (bodySource === "request" && input) {
                input = new Request(input, { body: nextBody });
              }
              reqBody = nextBody;
              usedRootLink = true;
              logger.info(
                `[ecoclaw] response_root_link injected previous_response_id model=${model} ratio=${ratio.toFixed(2)}`,
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          `[ecoclaw] response_root_link preflight parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const startedAt = new Date().toISOString();
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    const res = await origFetch(input, init);

    if (cfg.responseRootLinkEnabled && isProviderCall && isResponsesCall && typeof reqBody === "string" && reqBody) {
      try {
        const reqJson = JSON.parse(reqBody);
        const model = String(reqJson?.model ?? "");
        const instructions = normalizeText(String(reqJson?.instructions ?? ""));
        const hasPrev = typeof reqJson?.previous_response_id === "string" && reqJson.previous_response_id.length > 0;
        if (!hasPrev && instructions.length >= cfg.responseRootMinInstructionChars && model) {
          const clone = res.clone();
          const txt = await clone.text();
          const parsed = JSON.parse(txt);
          const responseId = String(parsed?.id ?? "");
          if (responseId) {
            const nowIso = new Date().toISOString();
            const inputText = normalizeText(extractInputText(reqJson?.input)).slice(0, cfg.responseRootPrefixMaxChars);
            const sig = sha256Hex(`${url}|${model}|${instructions}`);
            const prev = rootStateBySig.get(sig);
            const next: ResponseRootState = {
              rootResponseId: responseId,
              instructionSig: sig,
              instructionChars: instructions.length,
              prefixSample: inputText,
              model,
              endpoint: url,
              createdAt: prev?.createdAt ?? nowIso,
              updatedAt: nowIso,
            };
            rootStateBySig.set(sig, next);
            await persistRootState();
            logger.info(
              `[ecoclaw] response_root_link captured root model=${model} instrChars=${instructions.length} injected=${usedRootLink}`,
            );
          }
        }
      } catch {
        // Ignore parse errors from non-json responses.
      }
    }

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
          const rec = {
            at: startedAt,
            method,
            url,
            status: Number((res as any)?.status ?? 0),
            requestBody: reqBody || undefined,
            rootSig: rootSig || undefined,
            rootLinkInjected: usedRootLink || undefined,
            responseUsage: usage || undefined,
            responseBody: parsed ?? (txt ? txt.slice(0, 4000) : undefined),
          };
          if (cfg.debugTapProviderTraffic) {
            const p = cfg.debugTapPath;
            await mkdir(dirname(p), { recursive: true });
            await appendFile(p, `${JSON.stringify(rec)}\n`, "utf8");
          }
        } catch (err) {
          logger.warn(
            `[ecoclaw] provider tap write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }
    return res;
  };
  logger.info(
    `[ecoclaw] Provider interception enabled. tap=${cfg.debugTapProviderTraffic ? cfg.debugTapPath : "off"} rootLink=${cfg.responseRootLinkEnabled ? "on" : "off"}`,
  );
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
    "agent_end",
  ];
  for (const hookName of hookNames) {
    hookOn(api, hookName, async (event: any) => {
      try {
        const rec = {
          at: new Date().toISOString(),
          hook: hookName,
          sessionKey: extractSessionKey(event),
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
    event?.result?.sessionKey ??
    event?.meta?.sessionKey ??
    event?.ctx?.SessionKey ??
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

function extractLastUserMessage(event: any): string {
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
  const msgs = Array.isArray(event?.messages) ? event.messages : [];
  const out: string[] = [];
  for (const m of msgs) {
    const role = String(m?.role ?? "").toLowerCase();
    if (role !== "tool") continue;
    const text = contentToText(m?.content ?? m?.text ?? "").trim();
    if (text) out.push(text);
  }
  return out;
}

function buildProviderRawFromAssistant(assistant: any): Record<string, unknown> {
  const usage = (assistant?.usage ?? {}) as Record<string, unknown>;
  const inputRaw = usage.input_tokens ?? usage.input ?? usage.prompt_tokens ?? usage.promptTokens;
  const outputRaw = usage.output_tokens ?? usage.output ?? usage.completion_tokens ?? usage.completionTokens;
  const cacheReadRaw =
    usage.cacheRead ??
      usage.cache_read_tokens ??
      usage.cache_read_input_tokens ??
      (usage.prompt_tokens_details as any)?.cached_tokens;
  const input = Number(inputRaw);
  const output = Number(outputRaw);
  const cacheRead = Number(cacheReadRaw);
  const promptDetails: Record<string, unknown> = {};
  if (Number.isFinite(cacheRead)) promptDetails.cached_tokens = cacheRead;
  const out: Record<string, unknown> = {};
  if (Number.isFinite(input)) out.input_tokens = input;
  if (Number.isFinite(output)) out.output_tokens = output;
  if (Object.keys(promptDetails).length > 0) out.prompt_tokens_details = promptDetails;
  return out;
}

function buildProviderRawFromEvent(event: any, assistant: any): Record<string, unknown> {
  const fromAssistant = buildProviderRawFromAssistant(assistant);
  const hasAssistantUsage =
    Number(fromAssistant.input_tokens ?? 0) > 0 ||
    Number(fromAssistant.output_tokens ?? 0) > 0 ||
    Number((fromAssistant.prompt_tokens_details as any)?.cached_tokens ?? 0) > 0;
  if (hasAssistantUsage) return fromAssistant;

  const usage =
    event?.result?.meta?.agentMeta?.lastCallUsage ??
    event?.meta?.agentMeta?.lastCallUsage ??
    event?.agentMeta?.lastCallUsage ??
    event?.usage ??
    {};
  const input = Number(
    usage.input_tokens ??
      usage.inputTokens ??
      usage.input ??
      usage.prompt_tokens ??
      usage.promptTokens,
  );
  const output = Number(
    usage.output_tokens ??
      usage.outputTokens ??
      usage.output ??
      usage.completion_tokens ??
      usage.completionTokens,
  );
  const cacheRead = Number(
    usage.cacheRead ??
      usage.cache_read_tokens ??
      usage.cache_read_input_tokens ??
      usage.cached_input_tokens ??
      usage.cachedTokens ??
      usage.cacheHitTokens ??
      (usage.prompt_tokens_details as any)?.cached_tokens,
  );
  const cacheWrite = Number(
    usage.cacheWrite ??
      usage.cache_write_tokens ??
      usage.cache_write_input_tokens,
  );
  const promptDetails: Record<string, unknown> = {};
  if (Number.isFinite(cacheRead)) promptDetails.cached_tokens = cacheRead;
  if (Number.isFinite(cacheWrite)) promptDetails.cache_write_tokens = cacheWrite;
  const out: Record<string, unknown> = {};
  if (Number.isFinite(input)) out.input_tokens = input;
  if (Number.isFinite(output)) out.output_tokens = output;
  if (Object.keys(promptDetails).length > 0) out.prompt_tokens_details = promptDetails;
  return out;
}

function extractModelApi(event: any): string | undefined {
  const api =
    event?.result?.meta?.agentMeta?.api ??
    event?.meta?.agentMeta?.api ??
    event?.agentMeta?.api ??
    event?.modelApi ??
    event?.api;
  return typeof api === "string" && api.trim() ? api.trim() : undefined;
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

    if (!cfg.enabled) {
      logger.info("[ecoclaw] Plugin disabled by config.");
      return;
    }

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
        proxyRuntime = await startEmbeddedResponsesProxy(cfg, logger);
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

    if (cfg.debugTapProviderTraffic) {
      maybeInstallProviderTrafficTap(cfg, logger);
    }
    installLlmHookTap(api, cfg, logger);
    const topology = createSessionTopologyManager();
    registerEcoClawCommand(api, logger, topology, cfg);
    const shadowConnector =
      cfg.runtimeMode === "shadow"
        ? createOpenClawConnector({
            modules: [
              createCacheModule({ minPrefixChars: 32, tree: { ttlSeconds: cfg.cacheTtlSeconds } }),
              createPolicyModule({
                summaryTriggerInputTokens: cfg.summaryTriggerInputTokens,
                summaryTriggerStableChars: cfg.summaryTriggerStableChars,
                cacheProbeEnabled: cfg.cacheProbeEnabled,
                cacheProbeIntervalSeconds: cfg.cacheProbeIntervalSeconds,
                cacheProbeMaxPromptChars: cfg.cacheProbeMaxPromptChars,
                cacheProbeHitMinTokens: cfg.cacheProbeHitMinTokens,
                cacheProbeMissesToCold: cfg.cacheProbeMissesToCold,
                cacheProbeWarmSeconds: cfg.cacheProbeWarmSeconds,
              }),
              createCompactionTriggerModule({
                enabled: cfg.compactionTriggerEnabled,
                triggerInputTokens: cfg.compactionTriggerInputTokens,
                triggerTurnCount: cfg.compactionTriggerTurnCount,
                missRateThreshold: cfg.compactionTriggerMissRateThreshold,
                missRateWindowTurns: cfg.compactionTriggerWindowTurns,
                cooldownTurns: cfg.compactionTriggerCooldownTurns,
              }),
              createDecisionLedgerModule(),
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
      const sessionKey = extractSessionKey(event);
      const userMessage = extractLastUserMessage(event);
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
          logger.info(`[ecoclaw] session new -> ${topology.getStatus(sessionKey)} logical=${logical}`);
        } else {
          logger.info(`[ecoclaw] ${commandHelpText().replace(/\n/g, " | ")}`);
        }
      }
      if (!debugEnabled) return;
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
      const logicalSessionId = topology.getLogicalSessionId(sessionKey);
      const userMessage = extractLastUserMessage(event) || "[empty-user-message]";
      const inlineCmd = parseEcoClawCommand(userMessage);
      if (inlineCmd.kind !== "none") {
        if (debugEnabled) {
          logger.debug(`[ecoclaw] skip shadow runtime for command message session=${sessionKey}`);
        }
        return;
      }
      const assistantContent = contentToText(lastAssistant?.content ?? "");
      const openClawPromptRoot = await extractOpenClawPromptRoot(event);
      const turnTools = extractTurnTools(event);
      const providerId = String(provider || "openai").toLowerCase();
      const runtimeProvider = providerId.includes("anthropic") ? "anthropic" : "openai";
      const runtimeModel = String(model || (runtimeProvider === "anthropic" ? "claude-sonnet-4" : "gpt-5"));
      const modelApi = extractModelApi(event);

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
          modelApi: modelApi ?? undefined,
          openclawPromptRoot: openClawPromptRoot || undefined,
          turnTools: turnTools.length > 0 ? turnTools : undefined,
        },
      };

      try {
        const shadowResult = await shadowConnector.onLlmCall(turnCtx, async () => ({
          content: assistantContent,
          usage: {
            providerRaw: buildProviderRawFromEvent(event, lastAssistant),
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
          void ensureProxyReady();
          logger.info("[ecoclaw] Plugin active.");
          if (proxyRuntime?.baseUrl) {
            logger.info(`[ecoclaw] Embedded proxy active at ${proxyRuntime.baseUrl}`);
          } else {
            logger.info("[ecoclaw] Embedded proxy unavailable; ecoclaw provider was not registered.");
          }
          logger.info("[ecoclaw] Use explicit model key: ecoclaw/<model> (example: ecoclaw/gpt-5.4).");
          logger.info(
            `[ecoclaw] Runtime mode=${cfg.runtimeMode} stateDir=${cfg.stateDir} autoFork=${cfg.autoForkOnPolicy} cacheTtl=${cfg.cacheTtlSeconds}s summaryTriggerInputTokens=${cfg.summaryTriggerInputTokens}`,
          );
          if (cfg.eventTracePath) {
            logger.info(`[ecoclaw] Event trace path=${cfg.eventTracePath}`);
          }
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
