#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
REPO_DIR=$(cd -- "$PKG_DIR/../.." && pwd)

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
TRACE_PATH="${ECOCLAW_TRACE_PATH:-$HOME/.openclaw/ecoclaw-plugin-state/ecoclaw/event-trace.jsonl}"
KEEP_CONFIG="${KEEP_CONFIG:-0}"
RESTART_GATEWAY="${RESTART_GATEWAY:-1}"
STATE_DIR="${ECOCLAW_STATE_DIR:-$HOME/.openclaw/ecoclaw-plugin-state}"

SEMANTIC_ENABLED="${SEMANTIC_ENABLED:-1}"
SEMANTIC_PYTHON_BIN="${SEMANTIC_PYTHON_BIN:-/mnt/8t/xubuqiang/anaconda3/bin/python}"
SEMANTIC_TIMEOUT_MS="${SEMANTIC_TIMEOUT_MS:-120000}"
SEMANTIC_LLM_MODEL_PATH="${SEMANTIC_LLM_MODEL_PATH:-/mnt/20t/xubuqiang/models/llmlingua-2-bert-base-multilingual-cased-meetingbank}"
SEMANTIC_TARGET_RATIO="${SEMANTIC_TARGET_RATIO:-0.55}"
SEMANTIC_MIN_INPUT_CHARS="${SEMANTIC_MIN_INPUT_CHARS:-400}"
SEMANTIC_MIN_SAVED_CHARS="${SEMANTIC_MIN_SAVED_CHARS:-80}"
SEMANTIC_PRESELECT_RATIO="${SEMANTIC_PRESELECT_RATIO:-0.8}"
SEMANTIC_MAX_CHUNK_CHARS="${SEMANTIC_MAX_CHUNK_CHARS:-400}"

EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-local}"
EMBEDDING_MODEL_PATH="${EMBEDDING_MODEL_PATH:-/mnt/20t/xubuqiang/models/all-MiniLM-L6-v2}"
EMBEDDING_API_BASE_URL="${EMBEDDING_API_BASE_URL:-}"
EMBEDDING_API_KEY="${EMBEDDING_API_KEY:-}"
EMBEDDING_API_MODEL="${EMBEDDING_API_MODEL:-text-embedding-3-small}"
EMBEDDING_REQUEST_TIMEOUT_MS="${EMBEDDING_REQUEST_TIMEOUT_MS:-30000}"

TEST_MESSAGE="${TEST_MESSAGE:-Write a detailed implementation memo about cache health, reduction, semantic compression, and plugin configuration. Use 14 bullets plus a short checklist. Keep it concrete and technical, around 1200-1800 Chinese characters.}"
SESSION_ID="${SESSION_ID:-ecoclaw-semantic-e2e-$(date +%s)-$$}"
OUT_DIR="${ECOCLAW_SEMANTIC_E2E_OUT_DIR:-$PKG_DIR/.tmp/semantic-e2e}"
PLUGIN_LOAD_PATH="${PLUGIN_LOAD_PATH:-$PKG_DIR}"
REQUIRE_SEMANTIC_CHANGED="${REQUIRE_SEMANTIC_CHANGED:-1}"
TRACE_WAIT_SECONDS="${TRACE_WAIT_SECONDS:-45}"

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

if [[ ! -x "$SEMANTIC_PYTHON_BIN" ]]; then
  echo "python executable not found: $SEMANTIC_PYTHON_BIN" >&2
  exit 2
fi

cp "$CONFIG_PATH" "$BACKUP_PATH"

echo "[semantic-e2e] building plugin dist"
(cd "$PKG_DIR" && corepack pnpm exec tsx build.ts >/dev/null)

TRACE_COUNT_BEFORE=$(python - <<'PY' "$TRACE_PATH"
from pathlib import Path
import sys
p = Path(sys.argv[1])
print(len(p.read_text(errors="ignore").splitlines()) if p.exists() else 0)
PY
)

echo "[semantic-e2e] writing temporary plugin config"
python - <<'PY' "$CONFIG_PATH" "$STATE_DIR" "$PLUGIN_LOAD_PATH" "$SEMANTIC_ENABLED" "$SEMANTIC_PYTHON_BIN" "$SEMANTIC_TIMEOUT_MS" "$SEMANTIC_LLM_MODEL_PATH" "$SEMANTIC_TARGET_RATIO" "$SEMANTIC_MIN_INPUT_CHARS" "$SEMANTIC_MIN_SAVED_CHARS" "$SEMANTIC_PRESELECT_RATIO" "$SEMANTIC_MAX_CHUNK_CHARS" "$EMBEDDING_PROVIDER" "$EMBEDDING_MODEL_PATH" "$EMBEDDING_API_BASE_URL" "$EMBEDDING_API_KEY" "$EMBEDDING_API_MODEL" "$EMBEDDING_REQUEST_TIMEOUT_MS"
import json, sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
state_dir = sys.argv[2]
plugin_path = sys.argv[3]
semantic_enabled = sys.argv[4] == "1"
python_bin = sys.argv[5]
timeout_ms = int(sys.argv[6])
llm_model_path = sys.argv[7]
target_ratio = float(sys.argv[8])
min_input_chars = int(sys.argv[9])
min_saved_chars = int(sys.argv[10])
preselect_ratio = float(sys.argv[11])
max_chunk_chars = int(sys.argv[12])
embedding_provider = sys.argv[13]
embedding_model_path = sys.argv[14]
embedding_api_base_url = sys.argv[15]
embedding_api_key = sys.argv[16]
embedding_api_model = sys.argv[17]
embedding_request_timeout_ms = int(sys.argv[18])

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
    "enabled": False,
    "autoForkOnPolicy": False,
}
embedding = {
    "provider": embedding_provider,
    "requestTimeoutMs": embedding_request_timeout_ms,
}
if embedding_model_path:
    embedding["modelPath"] = embedding_model_path
if embedding_api_base_url:
    embedding["apiBaseUrl"] = embedding_api_base_url
if embedding_api_key:
    embedding["apiKey"] = embedding_api_key
if embedding_api_model:
    embedding["apiModel"] = embedding_api_model
config["semanticReduction"] = {
    "enabled": semantic_enabled,
    "pythonBin": python_bin,
    "timeoutMs": timeout_ms,
    "llmlinguaModelPath": llm_model_path,
    "targetRatio": target_ratio,
    "minInputChars": min_input_chars,
    "minSavedChars": min_saved_chars,
    "preselectRatio": preselect_ratio,
    "maxChunkChars": max_chunk_chars,
    "embedding": embedding,
}
cfg_path.write_text(json.dumps(obj, ensure_ascii=False, indent=2))
PY

if [[ "$RESTART_GATEWAY" == "1" ]]; then
  echo "[semantic-e2e] restarting gateway"
  "$OPENCLAW_BIN" gateway restart >/dev/null
fi

echo "[semantic-e2e] running agent session=$SESSION_ID"
"$OPENCLAW_BIN" agent --session-id "$SESSION_ID" --thinking off --message "$TEST_MESSAGE" --json \
  | sed -n '/^{/,$p' > "$RESULT_JSON"

echo "[semantic-e2e] collecting trace delta"
python - <<'PY' "$TRACE_PATH" "$TRACE_COUNT_BEFORE" "$SUMMARY_JSON" "$SESSION_ID" "$REQUIRE_SEMANTIC_CHANGED" "$TRACE_WAIT_SECONDS"
import json, sys
import time
from pathlib import Path

trace_path = Path(sys.argv[1])
before = int(sys.argv[2])
summary_path = Path(sys.argv[3])
session_id = sys.argv[4]
require_semantic_changed = sys.argv[5] == "1"
trace_wait_seconds = int(sys.argv[6])

deadline = time.time() + max(1, trace_wait_seconds)
lines = []
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

target = None
for line in reversed(new_lines):
    obj = json.loads(line)
    if obj.get("logicalSessionId") or obj.get("physicalSessionId"):
        target = obj
        break
if target is None:
    raise SystemExit("failed to locate new trace entry")

result_events = target.get("resultEvents") or []
final_context_events = target.get("finalContextEvents") or []

after_reduction = next((e for e in result_events if e.get("type") == "reduction.after_call.recorded"), None)
before_reduction = next((e for e in final_context_events if e.get("type") == "reduction.before_call.recorded"), None)
policy_reduction = next((e for e in final_context_events if e.get("type") == "policy.reduction.decided"), None)
policy_cache_health = next((e for e in final_context_events if e.get("type") == "policy.cache.health.decided"), None)
policy_summary = next((e for e in final_context_events if e.get("type") == "policy.summary.requested"), None)

after_payload = (after_reduction or {}).get("payload") or {}
breakdown = after_payload.get("passBreakdown") or []
semantic = next((item for item in breakdown if item.get("id") == "semantic_llmlingua2"), None)
format_slimming = next((item for item in breakdown if item.get("id") == "format_slimming"), None)

summary = {
    "module": "semantic",
    "requiredValidatedKeys": [
        "policyReductionDecided",
        "policyCacheHealthDecided",
        "reductionBeforeCallRecorded",
        "reductionAfterCallRecorded",
        "semanticPassSeen",
        "semanticPassChanged",
    ],
    "sessionId": session_id,
    "traceAt": target.get("at"),
    "provider": target.get("provider"),
    "model": target.get("model"),
    "apiFamily": target.get("apiFamily"),
    "eventTypes": target.get("eventTypes") or [],
    "validated": {
        "policyReductionDecided": policy_reduction is not None,
        "policyCacheHealthDecided": policy_cache_health is not None,
        "policySummaryRequested": policy_summary is not None,
        "reductionBeforeCallRecorded": before_reduction is not None,
        "reductionAfterCallRecorded": after_reduction is not None,
        "semanticPassSeen": semantic is not None,
        "semanticPassChanged": bool(semantic and semantic.get("changed") is True),
    },
    "beforeCallReduction": (before_reduction or {}).get("payload"),
    "policyReduction": (policy_reduction or {}).get("payload"),
    "policyCacheHealth": (policy_cache_health or {}).get("payload"),
    "afterCallReduction": after_payload,
    "afterCallBreakdown": breakdown,
    "formatSlimming": format_slimming,
    "semanticLlmlingua2": semantic,
    "responsePreview": target.get("responsePreview"),
    "usage": target.get("usage"),
}
summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False, indent=2))
if require_semantic_changed and not summary["validated"]["semanticPassChanged"]:
    raise SystemExit("semantic pass did not change output")
PY

echo
echo "[semantic-e2e] summary file: $SUMMARY_JSON"
echo "[semantic-e2e] raw result file: $RESULT_JSON"
echo "[semantic-e2e] restore config after exit: $([[ "$KEEP_CONFIG" == "1" ]] && echo no || echo yes)"
