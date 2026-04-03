import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileRuntimeStateStore } from "@ecoclaw/storage-fs";
import { buildContextSessionView, buildContextViewSnapshot } from "../src/view.js";

test("context view reconstructs replay chains across branch forks", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ecoclaw-context-view-"));
  try {
    const store = createFileRuntimeStateStore({ stateDir });
    await store.appendBranch({
      branchId: "main",
      sessionId: "session-1",
      createdAt: "2026-04-02T10:00:00.000Z",
      source: "test",
    });
    await store.appendMessages([
      {
        messageId: "m1",
        sessionId: "session-1",
        branchId: "main",
        role: "user",
        kind: "message",
        origin: "provider_observed",
        content: "hello",
        createdAt: "2026-04-02T10:00:01.000Z",
      },
      {
        messageId: "m2",
        sessionId: "session-1",
        branchId: "main",
        parentMessageId: "m1",
        role: "assistant",
        kind: "message",
        origin: "provider_observed",
        content: "reply",
        createdAt: "2026-04-02T10:00:02.000Z",
      },
    ]);
    await store.appendBranch({
      branchId: "fork-1",
      sessionId: "session-1",
      parentBranchId: "main",
      forkedFromMessageId: "m2",
      createdAt: "2026-04-02T10:00:03.000Z",
      source: "test",
    });
    await store.appendMessages([
      {
        messageId: "m3",
        sessionId: "session-1",
        branchId: "fork-1",
        parentMessageId: "m2",
        role: "system",
        kind: "checkpoint_seed",
        origin: "synthetic_materialized",
        content: "condensed seed",
        createdAt: "2026-04-02T10:00:04.000Z",
      },
      {
        messageId: "m4",
        sessionId: "session-1",
        branchId: "fork-1",
        parentMessageId: "m3",
        role: "user",
        kind: "message",
        origin: "manual_edit",
        content: "edited follow-up",
        createdAt: "2026-04-02T10:00:05.000Z",
      },
    ]);

    const view = await buildContextSessionView({
      store,
      sessionId: "session-1",
      activeBranchId: "fork-1",
    });
    const snapshot = buildContextViewSnapshot(view);

    assert.equal(view.branches.length, 2);
    assert.deepEqual(view.activeReplayMessageIds, ["m1", "m2", "m3", "m4"]);
    assert.equal(view.branchesById["fork-1"]?.replayMessageCount, 4);
    assert.equal(view.branchesById["fork-1"]?.syntheticMessageCount, 2);
    assert.equal(snapshot.activeReplayMessages.length, 4);
    assert.equal(snapshot.activeReplayMessages[2]?.kind, "checkpoint_seed");
    assert.equal(snapshot.activeReplayMessages[3]?.origin, "manual_edit");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
