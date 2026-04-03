import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReductionPassHandler } from "./types.js";

const DEFAULT_TARGET_RATIO = 0.55;
const DEFAULT_MIN_INPUT_CHARS = 4000;
const DEFAULT_MIN_SAVED_CHARS = 200;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_PRESELECT_RATIO = 0.8;
const DEFAULT_MAX_CHUNK_CHARS = 1400;
const DEFAULT_EMBED_REQUEST_TIMEOUT_MS = 30000;

type WorkerRequest = {
  text: string;
  query: string;
  llmlingua_model_path: string;
  target_ratio: number;
  preselect_ratio: number;
  max_chunk_chars: number;
  embedding: {
    provider: "local" | "api" | "none";
    model_path?: string;
    api_base_url?: string;
    api_key?: string;
    api_model?: string;
    request_timeout_ms: number;
  };
};

type WorkerResponse = {
  ok: boolean;
  changed: boolean;
  compressed_text?: string;
  stats?: {
    original_chars: number;
    compressed_chars: number;
    selected_chunk_count: number;
    total_chunk_count: number;
    embedding_provider: string;
    target_ratio: number;
  };
  note?: string;
  skipped_reason?: string;
  warning?: string;
  error?: string;
};

type SemanticConfig = {
  enabled: boolean;
  pythonBin: string;
  timeoutMs: number;
  modelPath?: string;
  targetRatio: number;
  minInputChars: number;
  minSavedChars: number;
  preselectRatio: number;
  maxChunkChars: number;
  embeddingProvider: "local" | "api" | "none";
  embeddingModelPath?: string;
  embeddingApiBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingApiModel?: string;
  embeddingRequestTimeoutMs: number;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "semantic-llmlingua2-worker.py");

const asPositiveNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const asRatio = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(0.95, Math.max(0.05, value));
};

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

function resolveConfig(options?: Record<string, unknown>): SemanticConfig {
  const provider = asTrimmedString(options?.embeddingProvider);
  return {
    enabled: options?.enabled === true,
    pythonBin: asTrimmedString(options?.pythonBin) ?? "python",
    timeoutMs: asPositiveNumber(options?.timeoutMs, DEFAULT_TIMEOUT_MS),
    modelPath: asTrimmedString(options?.modelPath),
    targetRatio: asRatio(options?.targetRatio, DEFAULT_TARGET_RATIO),
    minInputChars: asPositiveNumber(options?.minInputChars, DEFAULT_MIN_INPUT_CHARS),
    minSavedChars: asPositiveNumber(options?.minSavedChars, DEFAULT_MIN_SAVED_CHARS),
    preselectRatio: asRatio(options?.preselectRatio, DEFAULT_PRESELECT_RATIO),
    maxChunkChars: asPositiveNumber(options?.maxChunkChars, DEFAULT_MAX_CHUNK_CHARS),
    embeddingProvider:
      provider === "local" || provider === "api" || provider === "none" ? provider : "none",
    embeddingModelPath: asTrimmedString(options?.embeddingModelPath),
    embeddingApiBaseUrl: asTrimmedString(options?.embeddingApiBaseUrl),
    embeddingApiKey: asTrimmedString(options?.embeddingApiKey),
    embeddingApiModel: asTrimmedString(options?.embeddingApiModel),
    embeddingRequestTimeoutMs: asPositiveNumber(
      options?.embeddingRequestTimeoutMs,
      DEFAULT_EMBED_REQUEST_TIMEOUT_MS,
    ),
  };
}

async function runWorker(
  pythonBin: string,
  timeoutMs: number,
  payload: WorkerRequest,
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [WORKER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`semantic_llmlingua2_timeout_${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(err || `semantic_llmlingua2_worker_exit_${code ?? "unknown"}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as WorkerResponse);
      } catch (parseErr) {
        reject(
          new Error(
            `semantic_llmlingua2_worker_invalid_json: ${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            }${err ? ` | stderr=${err}` : ""}`,
          ),
        );
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

export const semanticLlmlingua2Pass: ReductionPassHandler = {
  async afterCall({ turnCtx, currentResult, spec }) {
    const cfg = resolveConfig(spec.options);
    if (!cfg.enabled) {
      return {
        changed: false,
        skippedReason: "semantic_disabled",
      };
    }

    const text = currentResult.content.trim();
    if (!text) {
      return {
        changed: false,
        skippedReason: "empty_content",
      };
    }
    if (text.length < cfg.minInputChars) {
      return {
        changed: false,
        skippedReason: "below_min_input_chars",
      };
    }
    if (!cfg.modelPath) {
      return {
        changed: false,
        skippedReason: "semantic_model_path_missing",
      };
    }

    const request: WorkerRequest = {
      text: currentResult.content,
      query: String(turnCtx.prompt ?? ""),
      llmlingua_model_path: cfg.modelPath,
      target_ratio: cfg.targetRatio,
      preselect_ratio: cfg.preselectRatio,
      max_chunk_chars: cfg.maxChunkChars,
      embedding: {
        provider: cfg.embeddingProvider,
        model_path: cfg.embeddingModelPath,
        api_base_url: cfg.embeddingApiBaseUrl,
        api_key: cfg.embeddingApiKey,
        api_model: cfg.embeddingApiModel,
        request_timeout_ms: cfg.embeddingRequestTimeoutMs,
      },
    };

    let response: WorkerResponse;
    try {
      response = await runWorker(cfg.pythonBin, cfg.timeoutMs, request);
    } catch (err) {
      return {
        changed: false,
        skippedReason: "semantic_worker_failed",
        note: err instanceof Error ? err.message : String(err),
      };
    }

    if (!response.ok) {
      return {
        changed: false,
        skippedReason: response.skipped_reason ?? "semantic_worker_error",
        note: response.error ?? response.warning,
      };
    }

    const compressedText = typeof response.compressed_text === "string" ? response.compressed_text : "";
    if (!response.changed || !compressedText) {
      return {
        changed: false,
        skippedReason: response.skipped_reason ?? "semantic_no_savings",
        note: response.note ?? response.warning,
      };
    }

    const savedChars = currentResult.content.length - compressedText.length;
    if (savedChars < cfg.minSavedChars) {
      return {
        changed: false,
        skippedReason: "semantic_saved_chars_below_minimum",
        note: `saved=${savedChars}`,
      };
    }

    const providerTag =
      response.stats?.embedding_provider && response.stats.embedding_provider.length > 0
        ? response.stats.embedding_provider
        : cfg.embeddingProvider;

    return {
      changed: true,
      note:
        response.note ??
        `semantic_llmlingua2:${providerTag}:saved=${savedChars}:ratio=${response.stats?.target_ratio ?? cfg.targetRatio}`,
      metadata: {
        semanticLlmlingua2: {
          stats: response.stats,
          warning: response.warning,
        },
      },
      result: {
        ...currentResult,
        content: compressedText,
      },
    };
  },
};
