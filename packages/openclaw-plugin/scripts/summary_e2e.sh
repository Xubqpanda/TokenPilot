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

SUMMARY_GENERATION_MODE="${SUMMARY_GENERATION_MODE:-heuristic}"
SUMMARY_FALLBACK_TO_HEURISTIC="${SUMMARY_FALLBACK_TO_HEURISTIC:-1}"
SUMMARY_MAX_OUTPUT_TOKENS="${SUMMARY_MAX_OUTPUT_TOKENS:-1200}"
INCLUDE_ASSISTANT_REPLY="${INCLUDE_ASSISTANT_REPLY:-1}"
COMPACTION_ENABLED="${COMPACTION_ENABLED:-0}"

SESSION_ID="${SESSION_ID:-ecoclaw-summary-e2e-$(date +%s)-$$}"
OUT_DIR="${ECOCLAW_SUMMARY_E2E_OUT_DIR:-$PKG_DIR/.tmp/summary-e2e}"
PLUGIN_LOAD_PATH="${PLUGIN_LOAD_PATH:-$PKG_DIR}"
TRACE_WAIT_SECONDS="${TRACE_WAIT_SECONDS:-45}"
TEST_MESSAGE="${TEST_MESSAGE:-请基于当前上下文正常回复，并在内容里包含 SUMMARY_OK。}"

mkdir -p "$OUT_DIR"

BACKUP_PATH="$OUT_DIR/openclaw.json.backup.$(date +%s)"
RESULT_JSON="$OUT_DIR/result-${SESSION_ID}.json"
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

echo "[summary-e2e] building plugin dist"
(cd "$PKG_DIR" && corepack pnpm exec tsx build.ts >/dev/null)

TRACE_COUNT_BEFORE=$(python - <<'PY' "$TRACE_PATH"
from pathlib import Path
import sys
p = Path(sys.argv[1])
print(len(p.read_text(errors="ignore").splitlines()) if p.exists() else 0)
PY
)

echo "[summary-e2e] writing temporary plugin config"
python - <<'PY' "$CONFIG_PATH" "$STATE_DIR" "$PLUGIN_LOAD_PATH" \
  "$SUMMARY_GENERATION_MODE" "$SUMMARY_FALLBACK_TO_HEURISTIC" "$SUMMARY_MAX_OUTPUT_TOKENS" \
  "$INCLUDE_ASSISTANT_REPLY" "$COMPACTION_ENABLED"
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
    "enabled": sys.argv[8] == "1",
    "autoForkOnPolicy": False,
    "summaryGenerationMode": sys.argv[4],
    "summaryFallbackToHeuristic": sys.argv[5] == "1",
    "summaryMaxOutputTokens": int(sys.argv[6]),
    "includeAssistantReply": sys.argv[7] == "1",
}
cfg_path.write_text(json.dumps(obj, ensure_ascii=False, indent=2))
PY

if [[ "$RESTART_GATEWAY" == "1" ]]; then
  echo "[summary-e2e] restarting gateway"
  "$OPENCLAW_BIN" gateway restart >/dev/null
fi

echo "[summary-e2e] running agent session=$SESSION_ID"
"$OPENCLAW_BIN" agent --session-id "$SESSION_ID" --thinking off --message "$TEST_MESSAGE" --json \
  | sed -n '/^{/,$p' > "$RESULT_JSON"

echo "[summary-e2e] collecting trace delta"
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
        if new_lines:
            break
    time.sleep(1)

if not trace_path.exists():
    raise SystemExit(f"trace not found: {trace_path}")
if not new_lines:
    raise SystemExit("no new trace lines found")

entry = json.loads(new_lines[-1])
event_types = set(entry.get("eventTypes") or [])
result_events = entry.get("resultEvents") or []
final_context_events = entry.get("finalContextEvents") or []

policy_summary_event = next((e for e in final_context_events if e.get("type") == "policy.summary.requested"), None)
summary_event = next((e for e in result_events if e.get("type") == "summary.generated"), None)
context_state_event = next((e for e in result_events if e.get("type") == "context.state.updated"), None)

summary = {
    "module": "summary",
    "requiredValidatedKeys": [
        "policySummaryRequested",
        "summaryGenerated",
        "contextStateUpdated",
        "compactionPlanNotGenerated",
        "compactionApplyNotExecuted",
    ],
    "sessionId": entry.get("logicalSessionId") or entry.get("physicalSessionId"),
    "traceAt": entry.get("at"),
    "provider": entry.get("provider"),
    "model": entry.get("model"),
    "apiFamily": entry.get("apiFamily"),
    "eventTypes": entry.get("eventTypes") or [],
    "validated": {
        "policySummaryRequested": policy_summary_event is not None,
        "summaryGenerated": summary_event is not None,
        "contextStateUpdated": context_state_event is not None,
        "compactionPlanNotGenerated": "compaction.plan.generated" not in event_types,
        "compactionApplyNotExecuted": "compaction.apply.executed" not in event_types,
    },
    "policySummary": (policy_summary_event or {}).get("payload"),
    "summaryArtifact": ((summary_event or {}).get("payload") or {}).get("artifact"),
    "contextState": (context_state_event or {}).get("payload"),
    "usage": entry.get("usage"),
    "responsePreview": entry.get("responsePreview"),
}
summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False, indent=2))

for key, value in summary["validated"].items():
    if not value:
        raise SystemExit(f"validation failed: {key}=false")
PY

echo
echo "[summary-e2e] summary file: $SUMMARY_JSON"
echo "[summary-e2e] raw result file: $RESULT_JSON"
echo "[summary-e2e] restore config after exit: $([[ "$KEEP_CONFIG" == "1" ]] && echo no || echo yes)"
