import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  PersistedBranchRecord,
  PersistedMessageRecord,
  PersistedSessionMeta,
  PersistedTurnRecord,
  RuntimeStateStore,
} from "@ecoclaw/kernel";

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
      turnCount: 1,
    });
  }

  async appendBranch(record: PersistedBranchRecord): Promise<void> {
    await this.ensureReady();
    const sessionDir = this.getSessionDir(record.sessionId);
    const branchesPath = join(sessionDir, "branches.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await appendFile(branchesPath, `${this.safeStringify(record)}\n`, "utf8");
    await this.upsertSessionMeta(record.sessionId, {
      updatedAt: record.createdAt,
      branchCount: 1,
      turnCount: 0,
    });
  }

  async appendMessages(records: PersistedMessageRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.ensureReady();
    const bySession = new Map<string, PersistedMessageRecord[]>();
    for (const record of records) {
      const existing = bySession.get(record.sessionId) ?? [];
      existing.push(record);
      bySession.set(record.sessionId, existing);
    }

    for (const [sessionId, sessionRecords] of bySession.entries()) {
      const sessionDir = this.getSessionDir(sessionId);
      const messagesPath = join(sessionDir, "messages.jsonl");
      await mkdir(sessionDir, { recursive: true });
      const payload = `${sessionRecords.map((record) => this.safeStringify(record)).join("\n")}\n`;
      await appendFile(messagesPath, payload, "utf8");
      const latest = sessionRecords.reduce((max, record) => (record.createdAt > max ? record.createdAt : max), "");
      await this.upsertSessionMeta(sessionId, {
        updatedAt: latest || new Date().toISOString(),
        messageCount: sessionRecords.length,
        turnCount: 0,
      });
    }
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
      apiFamily: update.apiFamily ?? current?.apiFamily,
      lastStatus: update.lastStatus ?? current?.lastStatus,
      turnCount: (current?.turnCount ?? 0) + (update.turnCount ?? 0),
      messageCount: (current?.messageCount ?? 0) + (update.messageCount ?? 0),
      branchCount: (current?.branchCount ?? 0) + (update.branchCount ?? 0),
    };
    await this.writeJson(metaPath, next);
    return next;
  }

  async readSessionMeta(sessionId: string): Promise<PersistedSessionMeta | null> {
    await this.ensureReady();
    return this.readJson<PersistedSessionMeta>(join(this.getSessionDir(sessionId), "meta.json"));
  }

  async listTurns(sessionId: string): Promise<PersistedTurnRecord[]> {
    await this.ensureReady();
    return this.readJsonLines<PersistedTurnRecord>(join(this.getSessionDir(sessionId), "turns.jsonl"));
  }

  async listBranches(sessionId: string): Promise<PersistedBranchRecord[]> {
    await this.ensureReady();
    return this.readJsonLines<PersistedBranchRecord>(join(this.getSessionDir(sessionId), "branches.jsonl"));
  }

  async listMessages(
    sessionId: string,
    options: { branchId?: string } = {},
  ): Promise<PersistedMessageRecord[]> {
    await this.ensureReady();
    const messages = await this.readJsonLines<PersistedMessageRecord>(
      join(this.getSessionDir(sessionId), "messages.jsonl"),
    );
    if (!options.branchId) return messages;
    return messages.filter((record) => record.branchId === options.branchId);
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

  private async readJsonLines<T>(filePath: string): Promise<T[]> {
    try {
      const raw = await readFile(filePath, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as T);
    } catch {
      return [];
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
