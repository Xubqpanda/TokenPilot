#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
TRACE_PATH="${ECOCLAW_TRACE_PATH:-$HOME/.openclaw/ecoclaw-plugin-state/ecoclaw/event-trace.jsonl}"
KEEP_CONFIG="${KEEP_CONFIG:-0}"
RESTART_GATEWAY="${RESTART_GATEWAY:-1}"
STATE_DIR="${ECOCLAW_STATE_DIR:-$HOME/.openclaw/ecoclaw-plugin-state}"

COMPACTION_ENABLED="${COMPACTION_ENABLED:-1}"
AUTO_FORK_ON_POLICY="${AUTO_FORK_ON_POLICY:-1}"
SUMMARY_GENERATION_MODE="${SUMMARY_GENERATION_MODE:-heuristic}"
SUMMARY_FALLBACK_TO_HEURISTIC="${SUMMARY_FALLBACK_TO_HEURISTIC:-1}"
SUMMARY_MAX_OUTPUT_TOKENS="${SUMMARY_MAX_OUTPUT_TOKENS:-1200}"
INCLUDE_ASSISTANT_REPLY="${INCLUDE_ASSISTANT_REPLY:-1}"
COMPACTION_COOLDOWN_TURNS="${COMPACTION_COOLDOWN_TURNS:-99}"

SESSION_ID="${SESSION_ID:-ecoclaw-compaction-e2e-$(date +%s)-$$}"
OUT_DIR="${ECOCLAW_COMPACTION_E2E_OUT_DIR:-$PKG_DIR/.tmp/compaction-e2e}"
PLUGIN_LOAD_PATH="${PLUGIN_LOAD_PATH:-$PKG_DIR}"
TRACE_WAIT_SECONDS="${TRACE_WAIT_SECONDS:-60}"

TURN1_MESSAGE="${TURN1_MESSAGE:-请回复 WARMUP_OK，并用一句中文确认进入 compaction 预热。}"
TURN2_MESSAGE="${TURN2_MESSAGE:-继续当前任务。请先用 3 条中文要点总结你记住的上下文，再在最后单独输出 COMPACT_OK。}"
TURN3_MESSAGE="${TURN3_MESSAGE:-继续刚才的压缩后上下文。只输出 POST_OK。}"

mkdir -p "$OUT_DIR"

BACKUP_PATH="$OUT_DIR/openclaw.json.backup.$(date +%s)"
TURN1_JSON="$OUT_DIR/turn1-${SESSION_ID}.json"
TURN2_JSON="$OUT_DIR/turn2-${SESSION_ID}.json"
TURN3_JSON="$OUT_DIR/turn3-${SESSION_ID}.json"
SUMMARY_JSON="$OUT_DIR/summary-${SESSION_ID}.json"

cleanup() {
  if [[ "$KEEP_CONFIG" != "1" && -f "$BACKUP_PATH" ]]; then
    cp "$BACKUP_PATH" "$CONFIG_PATH"
    if [[ "$RESTART_GATEWAY" == "1" ]]; then
      "$OPENCLAW_BIN" gateway restart >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "config not found: $CONFIG_PATH" >&2
  exit 2
fi

cp "$CONFIG_PATH" "$BACKUP_PATH"

echo "[compaction-e2e] building plugin dist"
(cd "$PKG_DIR" && corepack pnpm exec tsx build.ts >/dev/null)

TRACE_COUNT_BEFORE=$(python - <<'PY' "$TRACE_PATH"
from pathlib import Path
import sys
p = Path(sys.argv[1])
print(len(p.read_text(errors="ignore").splitlines()) if p.exists() else 0)
PY
)

echo "[compaction-e2e] writing temporary plugin config"
python - <<'PY' "$CONFIG_PATH" "$STATE_DIR" "$PLUGIN_LOAD_PATH" \
  "$COMPACTION_ENABLED" "$AUTO_FORK_ON_POLICY" "$SUMMARY_GENERATION_MODE" "$SUMMARY_FALLBACK_TO_HEURISTIC" \
  "$SUMMARY_MAX_OUTPUT_TOKENS" "$INCLUDE_ASSISTANT_REPLY" "$COMPACTION_COOLDOWN_TURNS"
import json, sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
state_dir = sys.argv[2]
plugin_path = sys.argv[3]

obj = json.loads(cfg_path.read_text())
plugins = obj.setdefault("plugins", {})
allow = plugins.setdefault("allow", [])
if "ecoclaw" not in allow:
    allow.append("ecoclaw")
load = plugins.setdefault("load", {})
paths = load.setdefault("paths", [])
if plugin_path not in paths:
    paths.append(plugin_path)
entries = plugins.setdefault("entries", {})
entry = entries.setdefault("ecoclaw", {})
entry["enabled"] = True
config = entry.setdefault("config", {})
config["stateDir"] = state_dir
config["compaction"] = {
    "enabled": sys.argv[4] == "1",
    "autoForkOnPolicy": sys.argv[5] == "1",
    "summaryGenerationMode": sys.argv[6],
    "summaryFallbackToHeuristic": sys.argv[7] == "1",
    "summaryMaxOutputTokens": int(sys.argv[8]),
    "includeAssistantReply": sys.argv[9] == "1",
    "compactionCooldownTurns": int(sys.argv[10]),
}
cfg_path.write_text(json.dumps(obj, ensure_ascii=False, indent=2))
PY

if [[ "$RESTART_GATEWAY" == "1" ]]; then
  echo "[compaction-e2e] restarting gateway"
  "$OPENCLAW_BIN" gateway restart >/dev/null
fi

run_turn() {
  local sid="$1"
  local msg="$2"
  local out="$3"
  "$OPENCLAW_BIN" agent --session-id "$sid" --thinking off --message "$msg" --json \
    | sed -n '/^{/,$p' > "$out"
}

echo "[compaction-e2e] running turn 1 session=$SESSION_ID"
run_turn "$SESSION_ID" "$TURN1_MESSAGE" "$TURN1_JSON"

echo "[compaction-e2e] running turn 2 session=$SESSION_ID"
run_turn "$SESSION_ID" "$TURN2_MESSAGE" "$TURN2_JSON"

echo "[compaction-e2e] running turn 3 session=$SESSION_ID"
run_turn "$SESSION_ID" "$TURN3_MESSAGE" "$TURN3_JSON"

echo "[compaction-e2e] collecting trace delta"
python - <<'PY' "$TRACE_PATH" "$TRACE_COUNT_BEFORE" "$SUMMARY_JSON" "$TRACE_WAIT_SECONDS"
import json, sys, time
from pathlib import Path

trace_path = Path(sys.argv[1])
before = int(sys.argv[2])
summary_path = Path(sys.argv[3])
trace_wait_seconds = int(sys.argv[4])
deadline = time.time() + max(1, trace_wait_seconds)

new_lines = []
while time.time() < deadline:
    if trace_path.exists():
        lines = trace_path.read_text(errors="ignore").splitlines()
        new_lines = lines[before:]
        if len(new_lines) >= 3:
            break
    time.sleep(1)

if not trace_path.exists():
    raise SystemExit(f"trace not found: {trace_path}")
if len(new_lines) < 3:
    raise SystemExit(f"expected at least 3 new trace lines, got {len(new_lines)}")

entries = [json.loads(line) for line in new_lines]
compaction_entry = None
for entry in entries:
    event_types = set(entry.get("eventTypes") or [])
    if "compaction.apply.executed" in event_types:
        compaction_entry = entry
        break

if compaction_entry is None:
    raise SystemExit("compaction apply event not found in new trace lines")

event_types = set(compaction_entry.get("eventTypes") or [])
result_events = compaction_entry.get("resultEvents") or []
final_context_events = compaction_entry.get("finalContextEvents") or []
apply_event = next((e for e in result_events if e.get("type") == "compaction.apply.executed"), None)
plan_event = next((e for e in result_events if e.get("type") == "compaction.plan.generated"), None)
summary_event = next((e for e in result_events if e.get("type") == "summary.generated"), None)
policy_compaction_event = next((e for e in final_context_events if e.get("type") == "policy.compaction.requested"), None)
policy_summary_event = next((e for e in final_context_events if e.get("type") == "policy.summary.requested"), None)

if apply_event is None:
    raise SystemExit("compaction.apply.executed payload missing")
apply_payload = apply_event.get("payload") or {}
to_physical = apply_payload.get("toPhysicalSessionId")
from_physical = apply_payload.get("fromPhysicalSessionId")
if not to_physical or not from_physical or to_physical == from_physical:
    raise SystemExit("compaction apply did not produce a new physical session id")

post_entry = next(
    (
        entry for entry in entries
        if entry is not compaction_entry
        and entry.get("logicalSessionId") == compaction_entry.get("logicalSessionId")
        and entry.get("physicalSessionId") == to_physical
    ),
    None,
)
if post_entry is None:
    raise SystemExit("no post-compaction turn found on the forked physical session")

summary = {
    "module": "compaction",
    "requiredValidatedKeys": [
        "policyCompactionRequested",
        "planGenerated",
        "applyExecuted",
        "newPhysicalSessionCreated",
        "postCompactionTurnRoutedToFork",
        "postCompactionTurnDidNotRecompact",
        "summaryGeneratedIfRequested",
    ],
    "sessionId": compaction_entry.get("logicalSessionId"),
    "traceAt": compaction_entry.get("at"),
    "apiFamily": compaction_entry.get("apiFamily"),
    "traceLineCount": len(new_lines),
    "validated": {
        "policyCompactionRequested": policy_compaction_event is not None,
        "planGenerated": plan_event is not None,
        "applyExecuted": apply_event is not None,
        "newPhysicalSessionCreated": bool(to_physical and from_physical and to_physical != from_physical),
        "postCompactionTurnRoutedToFork": post_entry is not None,
        "postCompactionTurnDidNotRecompact": "compaction.apply.executed" not in set(post_entry.get("eventTypes") or []),
        "summaryGeneratedIfRequested": summary_event is not None if policy_summary_event is not None else True,
    },
    "compactionEntry": {
        "at": compaction_entry.get("at"),
        "logicalSessionId": compaction_entry.get("logicalSessionId"),
        "physicalSessionId": compaction_entry.get("physicalSessionId"),
        "eventTypes": compaction_entry.get("eventTypes") or [],
        "usage": compaction_entry.get("usage"),
    },
    "policyCompaction": (policy_compaction_event or {}).get("payload"),
    "policySummary": (policy_summary_event or {}).get("payload"),
    "summaryArtifact": ((summary_event or {}).get("payload") or {}).get("artifact"),
    "compactionPlan": (plan_event or {}).get("payload"),
    "compactionApply": apply_payload,
    "postCompactionEntry": {
        "at": post_entry.get("at"),
        "logicalSessionId": post_entry.get("logicalSessionId"),
        "physicalSessionId": post_entry.get("physicalSessionId"),
        "eventTypes": post_entry.get("eventTypes") or [],
        "usage": post_entry.get("usage"),
    },
}
summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False, indent=2))

for key, value in summary["validated"].items():
    if not value:
        raise SystemExit(f"validation failed: {key}=false")
PY

echo
echo "[compaction-e2e] summary file: $SUMMARY_JSON"
echo "[compaction-e2e] restore config after exit: $([[ "$KEEP_CONFIG" == "1" ]] && echo no || echo yes)"
