import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PersistedSessionMeta, RuntimeStateStore, PersistedTurnRecord } from "@ecoclaw/kernel";

type SummaryFile = {
  sessionId: string;
  summary: string;
  source: string;
  updatedAt: string;
};

export type FileStateStoreConfig = {
  stateDir: string;
};

export class FileRuntimeStateStore implements RuntimeStateStore {
  private readonly rootDir: string;
  private readonly sessionsDir: string;

  constructor(private readonly cfg: FileStateStoreConfig) {
    this.rootDir = join(cfg.stateDir, "ecoclaw");
    this.sessionsDir = join(this.rootDir, "sessions");
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  async appendTurn(record: PersistedTurnRecord): Promise<void> {
    await this.ensureReady();
    const sessionDir = this.getSessionDir(record.sessionId);
    const turnsPath = join(sessionDir, "turns.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await appendFile(turnsPath, `${this.safeStringify(record)}\n`, "utf8");
    await this.upsertSessionMeta(record.sessionId, {
      updatedAt: record.endedAt,
      provider: record.provider,
      model: record.model,
      lastStatus: record.status,
    });
  }

  async upsertSessionMeta(sessionId: string, update: Partial<PersistedSessionMeta>): Promise<PersistedSessionMeta> {
    await this.ensureReady();
    const sessionDir = this.getSessionDir(sessionId);
    const metaPath = join(sessionDir, "meta.json");
    await mkdir(sessionDir, { recursive: true });

    const now = new Date().toISOString();
    const current = await this.readJson<PersistedSessionMeta>(metaPath);
    const next: PersistedSessionMeta = {
      sessionId,
      createdAt: current?.createdAt ?? now,
      updatedAt: update.updatedAt ?? now,
      provider: update.provider ?? current?.provider,
      model: update.model ?? current?.model,
      lastStatus: update.lastStatus ?? current?.lastStatus,
      turnCount: (current?.turnCount ?? 0) + (update.turnCount ?? 1),
    };
    await this.writeJson(metaPath, next);
    return next;
  }

  async writeSummary(sessionId: string, summary: string, source: string): Promise<void> {
    await this.ensureReady();
    const sessionDir = this.getSessionDir(sessionId);
    const summaryPath = join(sessionDir, "summary.json");
    await mkdir(sessionDir, { recursive: true });
    const payload: SummaryFile = {
      sessionId,
      summary,
      source,
      updatedAt: new Date().toISOString(),
    };
    await this.writeJson(summaryPath, payload);
    await this.upsertSessionMeta(sessionId, { updatedAt: payload.updatedAt, turnCount: 0 });
  }

  getRootDir(): string {
    return this.rootDir;
  }

  private getSessionDir(sessionId: string): string {
    return join(this.sessionsDir, this.safeName(sessionId));
  }

  private safeName(input: string): string {
    return input.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, this.safeStringify(value, 2), "utf8");
  }

  private safeStringify(value: unknown, space?: number): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      value,
      (_key, currentValue: unknown) => {
        if (typeof currentValue === "bigint") {
          return currentValue.toString();
        }
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
            stack: currentValue.stack,
          };
        }
        if (typeof currentValue === "function") {
          return `[Function ${currentValue.name || "anonymous"}]`;
        }
        if (currentValue && typeof currentValue === "object") {
          if (seen.has(currentValue as object)) {
            return "[Circular]";
          }
          seen.add(currentValue as object);
        }
        return currentValue;
      },
      space,
    );
  }
}

export function createFileRuntimeStateStore(cfg: FileStateStoreConfig): FileRuntimeStateStore {
  return new FileRuntimeStateStore(cfg);
}
