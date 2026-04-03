import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePromptText, type ResolvedPrompt } from "../semantic/prompt-loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUMMARY_PROMPT_PATH = join(__dirname, "prompts/default-summary.md");

export const DEFAULT_SUMMARY_PROMPT_FALLBACK = `You are generating a focused conversation-range summary.

Summarize only the selected blocks provided above.

Include:
- The current user intent inside the selected range
- Important assistant progress, decisions, or answers inside the selected range
- Important tool outputs or facts inside the selected range
- Any unresolved follow-up implied by the selected range

Be concise, structured, and do not include information that is outside the selected range.`;

async function loadDefaultSummaryPrompt(): Promise<string> {
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
