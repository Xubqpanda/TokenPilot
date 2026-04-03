import { readFile } from "node:fs/promises";

export type PromptSource = "default" | "inline" | "file";

export type ResolvedPrompt = {
  text: string;
  source: PromptSource;
  path?: string;
  error?: string;
};

const trimPrompt = (value?: string): string =>
  typeof value === "string" ? value.trim() : "";

async function loadPromptFile(path: string): Promise<ResolvedPrompt> {
  const raw = await readFile(path, "utf8");
  const text = raw.trim();
  if (!text) {
    throw new Error(`prompt file is empty: ${path}`);
  }
  return { text, source: "file", path };
}

const defaultPromptCache = new Map<string, Promise<ResolvedPrompt>>();

async function loadDefaultPrompt(
  fallback: string,
  preferredError?: string,
): Promise<ResolvedPrompt> {
  const cacheKey = `default::${fallback}::${preferredError ?? ""}`;
  const cached = defaultPromptCache.get(cacheKey);
  if (cached) return cached;

  const pending = Promise.resolve({
    text: fallback,
    source: "default" as const,
    error: preferredError,
  });
  defaultPromptCache.set(cacheKey, pending);
  return pending;
}

export async function resolvePromptText(params: {
  inline?: string;
  path?: string;
  fallback: string;
}): Promise<ResolvedPrompt> {
  const inline = trimPrompt(params.inline);
  if (inline) {
    return { text: inline, source: "inline" };
  }

  const path = trimPrompt(params.path);
  if (path) {
    try {
      return await loadPromptFile(path);
    } catch (err) {
      return loadDefaultPrompt(
        params.fallback,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return loadDefaultPrompt(params.fallback);
}
