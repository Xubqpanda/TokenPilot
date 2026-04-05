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
const DEFAULT_HANDOFF_PROMPT_PATH = MODULE_DIR
  ? join(MODULE_DIR, "prompts/default-handoff.md")
  : undefined;

export const DEFAULT_HANDOFF_PROMPT_FALLBACK = `You are preparing a task handoff for another LLM or sub-agent.

Include:
- Current progress and status
- Decisions, constraints, or user preferences that must be preserved
- The next concrete actions the receiver should take
- Any critical references, paths, commands, or data needed to continue

Keep it concise and operational.`;

async function loadDefaultHandoffPrompt(): Promise<string> {
  if (!DEFAULT_HANDOFF_PROMPT_PATH) {
    return DEFAULT_HANDOFF_PROMPT_FALLBACK;
  }
  try {
    return (await readFile(DEFAULT_HANDOFF_PROMPT_PATH, "utf8")).trim();
  } catch {
    return DEFAULT_HANDOFF_PROMPT_FALLBACK;
  }
}

export async function resolveHandoffPrompt(params: {
  inline?: string;
  path?: string;
}): Promise<ResolvedPrompt> {
  return resolvePromptText({
    inline: params.inline,
    path: params.path,
    fallback: await loadDefaultHandoffPrompt(),
  });
}
