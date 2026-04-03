import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileRuntimeStateStore } from "../src/index.js";

test("file state store persists turns, branches, and messages", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ecoclaw-storage-fs-"));
  try {
    const store = createFileRuntimeStateStore({ stateDir });
    const sessionId = "session-1";

    await store.appendBranch({
      branchId: "branch-main",
      sessionId,
      createdAt: "2026-04-02T10:00:00.000Z",
      source: "test",
    });

    await store.appendMessages([
      {
        messageId: "m1",
        sessionId,
        branchId: "branch-main",
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "hello",
        createdAt: "2026-04-02T10:00:01.000Z",
      },
      {
        messageId: "m2",
        sessionId,
        branchId: "branch-alt",
        parentMessageId: "m1",
        role: "assistant",
        kind: "summary",
        origin: "synthetic_materialized",
        content: "summary",
        createdAt: "2026-04-02T10:00:02.000Z",
      },
    ]);

    await store.appendTurn({
      turnId: "turn-1",
      sessionId,
      provider: "openai",
      model: "gpt-test",
      prompt: "continue",
      segments: [],
      responsePreview: "ok",
      startedAt: "2026-04-02T10:00:03.000Z",
      endedAt: "2026-04-02T10:00:04.000Z",
      status: "ok",
    });

    const meta = await store.readSessionMeta(sessionId);
    const branches = await store.listBranches(sessionId);
    const allMessages = await store.listMessages(sessionId);
    const branchMainMessages = await store.listMessages(sessionId, { branchId: "branch-main" });
    const turns = await store.listTurns(sessionId);

    assert.ok(meta);
    assert.equal(meta?.branchCount, 1);
    assert.equal(meta?.messageCount, 2);
    assert.equal(meta?.turnCount, 1);
    assert.equal(branches.length, 1);
    assert.equal(allMessages.length, 2);
    assert.equal(branchMainMessages.length, 1);
    assert.equal(branchMainMessages[0]?.messageId, "m1");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.turnId, "turn-1");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
