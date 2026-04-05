import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePromptText, type ResolvedPrompt } from "../semantic/prompt-loader.js";

function resolveModuleDir(): string | undefined {
  if (typeof __dirname === "string" && __dirname.length > 0) {
    return __dirname;
  }
  const importMetaUrl =
    typeof import.meta !== "undefined" && typeof import.meta.url === "string"
      ? import.meta.url
      : undefined;
  return importMetaUrl ? dirname(fileURLToPath(importMetaUrl)) : undefined;
}

const MODULE_DIR = resolveModuleDir();
const DEFAULT_SUMMARY_PROMPT_PATH = MODULE_DIR
  ? join(MODULE_DIR, "prompts/default-summary.md")
  : undefined;

export const DEFAULT_SUMMARY_PROMPT_FALLBACK = `You are generating a focused conversation-range summary.

Summarize only the selected blocks provided above.

Include:
- The current user intent inside the selected range
- Important assistant progress, decisions, or answers inside the selected range
- Important tool outputs or facts inside the selected range
- Any unresolved follow-up implied by the selected range

Be concise, structured, and do not include information that is outside the selected range.`;

async function loadDefaultSummaryPrompt(): Promise<string> {
  if (!DEFAULT_SUMMARY_PROMPT_PATH) {
    return DEFAULT_SUMMARY_PROMPT_FALLBACK;
  }
  try {
    return (await readFile(DEFAULT_SUMMARY_PROMPT_PATH, "utf8")).trim();
  } catch {
    return DEFAULT_SUMMARY_PROMPT_FALLBACK;
  }
}

export async function resolveSummaryPrompt(params: {
  inline?: string;
  path?: string;
}): Promise<ResolvedPrompt> {
  const fallback = await loadDefaultSummaryPrompt();
  return resolvePromptText({
    inline: params.inline,
    path: params.path,
    fallback,
  });
}
