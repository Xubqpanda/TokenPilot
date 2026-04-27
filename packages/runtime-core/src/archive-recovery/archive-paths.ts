import { createHash } from "node:crypto";
import { join } from "node:path";

export const LEGACY_PLUGIN_STATE_DIRNAME = "ecoclaw-plugin-state";
export const LEGACY_PLUGIN_NAMESPACE_DIR = "ecoclaw";
export const LEGACY_WORKSPACE_ARCHIVE_DIRNAME = ".ecoclaw-archives";
export const NEXT_PLUGIN_STATE_DIRNAME = "tokenpilot-plugin-state";
export const NEXT_PLUGIN_NAMESPACE_DIR = "tokenpilot";
export const NEXT_WORKSPACE_ARCHIVE_DIRNAME = ".tokenpilot-archives";

export function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function defaultPluginStateDir(): string {
  const envStateDir = process.env.TOKENPILOT_STATE_DIR || process.env.ECOCLAW_STATE_DIR;
  if (typeof envStateDir === "string" && envStateDir.trim().length > 0) {
    return envStateDir.trim();
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  return join(homeDir, ".openclaw", LEGACY_PLUGIN_STATE_DIRNAME);
}

export function pluginStateSubdir(stateDir: string, ...parts: string[]): string {
  return join(stateDir, LEGACY_PLUGIN_NAMESPACE_DIR, ...parts);
}

export function pluginStateSubdirCandidates(stateDir: string, ...parts: string[]): string[] {
  return [
    join(stateDir, NEXT_PLUGIN_NAMESPACE_DIR, ...parts),
    join(stateDir, LEGACY_PLUGIN_NAMESPACE_DIR, ...parts),
  ];
}

export function workspaceArchiveDir(workspaceDir: string): string {
  return join(workspaceDir, LEGACY_WORKSPACE_ARCHIVE_DIRNAME);
}

export function workspaceArchiveDirCandidates(workspaceDir: string): string[] {
  return [
    join(workspaceDir, NEXT_WORKSPACE_ARCHIVE_DIRNAME),
    join(workspaceDir, LEGACY_WORKSPACE_ARCHIVE_DIRNAME),
  ];
}

export function defaultArchiveDir(sessionId: string, workspaceDir?: string): string {
  if (workspaceDir) {
    return workspaceArchiveDir(workspaceDir);
  }
  const match = sessionId.match(/-(\d+)-j(\d+)$/);
  if (match) {
    const runId = match[1];
    const jobId = match[2];
    return `/tmp/pinchbench/${runId}/agent_workspace_j${jobId}/${LEGACY_WORKSPACE_ARCHIVE_DIRNAME}`;
  }
  return pluginStateSubdir(defaultPluginStateDir(), "tool-result-archives", sanitizePathPart(sessionId));
}

export function defaultArchiveLookupDirs(sessionId: string, stateDir?: string): string[] {
  const dirs: string[] = [];
  const sessionMatch = sessionId.match(/-(\d+)-j(\d+)$/);
  if (sessionMatch) {
    dirs.push(`/tmp/pinchbench/${sessionMatch[1]}/agent_workspace_j${sessionMatch[2]}/${NEXT_WORKSPACE_ARCHIVE_DIRNAME}`);
    dirs.push(`/tmp/pinchbench/${sessionMatch[1]}/agent_workspace_j${sessionMatch[2]}/${LEGACY_WORKSPACE_ARCHIVE_DIRNAME}`);
  }
  const resolvedStateDir = stateDir ?? defaultPluginStateDir();
  dirs.push(...pluginStateSubdirCandidates(resolvedStateDir, "tool-result-archives", sessionId));
  return Array.from(new Set(dirs));
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
