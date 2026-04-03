import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePromptText, type ResolvedPrompt } from "../semantic/prompt-loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMPACTION_PROMPT_PATH = join(__dirname, "prompts/default-compaction.md");
const DEFAULT_RESUME_PREFIX_PROMPT_PATH = join(__dirname, "prompts/default-resume-prefix.md");

export const DEFAULT_COMPACTION_PROMPT_FALLBACK = `You are performing a CONTEXT CHECKPOINT COMPACTION.
Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM
seamlessly continue the work.`;

export const DEFAULT_RESUME_PREFIX_PROMPT_FALLBACK = `Another language model started to solve this problem and produced
a summary of its thinking process. You also have access to the
state of the tools that were used by that language model. Use this
to build on the work that has already been done and avoid
duplicating work. Here is the summary produced by the other
language model, use the information in this summary to assist
with your own analysis:`;

async function loadFallback(path: string, fallback: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return fallback;
  }
}

export async function resolveCompactionPrompt(params: {
  inline?: string;
  path?: string;
}): Promise<ResolvedPrompt> {
  return resolvePromptText({
    inline: params.inline,
    path: params.path,
    fallback: await loadFallback(DEFAULT_COMPACTION_PROMPT_PATH, DEFAULT_COMPACTION_PROMPT_FALLBACK),
  });
}

export async function resolveResumePrefixPrompt(params: {
  inline?: string;
  path?: string;
}): Promise<ResolvedPrompt> {
  return resolvePromptText({
    inline: params.inline,
    path: params.path,
    fallback: await loadFallback(DEFAULT_RESUME_PREFIX_PROMPT_PATH, DEFAULT_RESUME_PREFIX_PROMPT_FALLBACK),
  });
}
