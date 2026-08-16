#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINCHBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CALLER_PWD="$(pwd -P)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

log_runtime_step() {
  local step="$1"
  printf '[run-method][%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${step}"
}

MODEL=""
JUDGE=""
SUITE=""
RUNS=""
TIMEOUT_MULTIPLIER=""
PARALLEL=""
SESSION_MODE=""
PHASE="full"
INPUT_JSON=""
OUTPUT_DIR_OVERRIDE=""
MAX_TASKS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      printf 'Usage: %s [--session-mode isolated|continuous] [--suite NAME] [options]\n' "$0"
      printf 'Requires TOKENPILOT_RUNTIME_ROOT and model/provider credentials.\n'
      exit 0
      ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --judge) JUDGE="${2:-}"; shift 2 ;;
    --suite) SUITE="${2:-}"; shift 2 ;;
    --runs) RUNS="${2:-}"; shift 2 ;;
    --timeout-multiplier) TIMEOUT_MULTIPLIER="${2:-}"; shift 2 ;;
    --parallel) PARALLEL="${2:-}"; shift 2 ;;
    --session-mode) SESSION_MODE="${2:-}"; shift 2 ;;
    --phase) PHASE="${2:-}"; shift 2 ;;
    --input-json) INPUT_JSON="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR_OVERRIDE="${2:-}"; shift 2 ;;
    --max-tasks) MAX_TASKS="${2:-}"; shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

import_runtime_envs
PROFILE_MODE="${SESSION_MODE:-${TOKENPILOT_SESSION_MODE:-isolated}}"
load_benchmark_profile tokenpilot "${PROFILE_MODE}"
install_tokenpilot_runtime
PINCHBENCH_TMP_ROOT="${PINCHBENCH_TMP_ROOT:-/tmp/pinchbench}"
export PINCHBENCH_TMP_ROOT
if [[ "${PINCHBENCH_TMP_ROOT}" != "/tmp/pinchbench" && -d "/tmp/pinchbench" ]]; then
  rm -rf /tmp/pinchbench 2>/dev/null || true
fi
MODEL_LIKE="${MODEL:-${TOKENPILOT_MODEL:-tokenpilot/gpt-5.4-mini}}"
JUDGE_LIKE="${JUDGE:-${TOKENPILOT_JUDGE:-tokenpilot/gpt-5.4-mini}}"
apply_model_runtime_env "${MODEL_LIKE}"
require_method_runtime_env
apply_runtime_env
if [[ "${PHASE}" != "eval" ]]; then
  export TOKENPILOT_FORCE_GATEWAY_RESTART="${TOKENPILOT_FORCE_GATEWAY_RESTART:-true}"
  log_runtime_step "recover_stale_openclaw_config_backup:start"
  recover_stale_openclaw_config_backup
  log_runtime_step "recover_stale_openclaw_config_backup:done"
  log_runtime_step "ensure_plugin_runtime_config:start"
  ensure_plugin_runtime_config
  log_runtime_step "ensure_plugin_runtime_config:done"
  log_runtime_step "sanitize_plugin_runtime_config:start"
  sanitize_plugin_runtime_config
  log_runtime_step "sanitize_plugin_runtime_config:done"
  log_runtime_step "ensure_pinchbench_exec_approvals:start"
  ensure_pinchbench_exec_approvals
  log_runtime_step "ensure_pinchbench_exec_approvals:done"
  log_runtime_step "validate_openclaw_runtime_config:start"
  validate_openclaw_runtime_config
  log_runtime_step "validate_openclaw_runtime_config:done"
  log_runtime_step "assert_method_runtime_config:start"
  assert_method_runtime_config
  log_runtime_step "assert_method_runtime_config:done"
  log_runtime_step "ensure_openclaw_gateway_running:start"
  ensure_openclaw_gateway_running
  log_runtime_step "ensure_openclaw_gateway_running:done"
  log_runtime_step "sanitize_plugin_runtime_config:post-gateway:start"
  sanitize_plugin_runtime_config
  log_runtime_step "sanitize_plugin_runtime_config:post-gateway:done"
  log_runtime_step "ensure_pinchbench_exec_approvals:post-gateway:start"
  ensure_pinchbench_exec_approvals
  log_runtime_step "ensure_pinchbench_exec_approvals:post-gateway:done"
  log_runtime_step "validate_openclaw_runtime_config:post-gateway:start"
  validate_openclaw_runtime_config
  log_runtime_step "validate_openclaw_runtime_config:post-gateway:done"
  log_runtime_step "assert_method_runtime_config:post-gateway:start"
  assert_method_runtime_config
  log_runtime_step "assert_method_runtime_config:post-gateway:done"
fi

if [[ -z "${PINCHBENCH_DATASET_DIR:-}" && -d "${PINCHBENCH_ROOT}/dataset" ]]; then
  export PINCHBENCH_DATASET_DIR="${PINCHBENCH_ROOT}/dataset"
fi

RESOLVED_MODEL="$(resolve_model_alias "${MODEL_LIKE}")"
RESOLVED_JUDGE="$(resolve_model_alias "${JUDGE_LIKE}")"
RESOLVED_SUITE="${SUITE:-${TOKENPILOT_SUITE:-automated-only}}"
RESOLVED_RUNS="${RUNS:-${TOKENPILOT_RUNS:-3}}"
RESOLVED_TIMEOUT="${TIMEOUT_MULTIPLIER:-${TOKENPILOT_TIMEOUT_MULTIPLIER:-1.0}}"
RESOLVED_PARALLEL="${PARALLEL:-${TOKENPILOT_PARALLEL:-1}}"
RESOLVED_SESSION_MODE="${SESSION_MODE:-${TOKENPILOT_SESSION_MODE:-isolated}}"

OUTPUT_DIR="${OUTPUT_DIR_OVERRIDE:-${PINCHBENCH_ROOT}/save/tokenpilot/${RESOLVED_SESSION_MODE}/raw}"
if [[ "${OUTPUT_DIR}" != /* ]]; then
  OUTPUT_DIR="$(python3 - "${CALLER_PWD}" "${OUTPUT_DIR}" <<'PY'
import os
import sys

base_dir = sys.argv[1]
output_dir = sys.argv[2]
print(os.path.abspath(os.path.join(base_dir, output_dir)))
PY
)"
fi
LOG_DIR="${PINCHBENCH_ROOT}/save/logs"
REPORT_DIR="${PINCHBENCH_ROOT}/save/reports"
RUN_TAG="$(date +%Y%m%d_%H%M%S)"
RUN_LOG_PREFIX="${LOG_DIR}/pinchbench_method_${RUN_TAG}"
RUN_LOG_FILE="${RUN_LOG_PREFIX}_generate.log"
EVAL_LOG_FILE="${RUN_LOG_PREFIX}_eval.log"
EVAL_JSONL_FILE="${RUN_LOG_PREFIX}_eval.jsonl"
TRACE_LIVE_LOG_FILE="${RUN_LOG_PREFIX}_plugin_trace_live.log"
GATEWAY_LIVE_LOG_FILE="${RUN_LOG_PREFIX}_gateway_live.log"
RUN_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "${OUTPUT_DIR}" "${LOG_DIR}" "${REPORT_DIR}"
export PINCHBENCH_EVAL_LOG_FILE="${EVAL_LOG_FILE}"
export PINCHBENCH_EVAL_JSONL_FILE="${EVAL_JSONL_FILE}"

PLUGIN_STATE_DIR="$(resolve_plugin_state_dir)"
PLUGIN_TRACE_FILE="${PLUGIN_STATE_DIR}/task-state/trace.jsonl"
GATEWAY_LOG_FILE="${PINCHBENCH_GATEWAY_LOG_FILE:-/tmp/openclaw_gateway.log}"
TRACE_TAIL_PID=""
GATEWAY_TAIL_PID=""
LIVE_DEBUG_STDOUT="${TOKENPILOT_LIVE_DEBUG_STDOUT:-false}"
ENABLE_LIVE_DEBUG_TAILS="${TOKENPILOT_ENABLE_LIVE_DEBUG_TAILS:-false}"

cleanup_live_debug_tails() {
  if [[ -n "${TRACE_TAIL_PID}" ]]; then
    kill "${TRACE_TAIL_PID}" >/dev/null 2>&1 || true
    wait "${TRACE_TAIL_PID}" >/dev/null 2>&1 || true
    TRACE_TAIL_PID=""
  fi
  if [[ -n "${GATEWAY_TAIL_PID}" ]]; then
    kill "${GATEWAY_TAIL_PID}" >/dev/null 2>&1 || true
    wait "${GATEWAY_TAIL_PID}" >/dev/null 2>&1 || true
    GATEWAY_TAIL_PID=""
  fi
}

run_method_exit_cleanup() {
  cleanup_live_debug_tails
  if [[ "${PINCHBENCH_CLEANUP_ISOLATED_SERVICES:-false}" =~ ^(true|1|yes)$ ]]; then
    local port
    for port in "${TOKENPILOT_GATEWAY_PORT:-}" "${PINCHBENCH_FWS_PORT:-}"; do
      [[ "${port}" =~ ^[0-9]+$ ]] || continue
      # Each benchmark worker owns a unique gateway/FWS port block. Releasing
      # it here also releases the OpenClaw file watchers before the next lane.
      fuser -k -TERM "${port}/tcp" >/dev/null 2>&1 || true
      if [[ "${port}" == "${PINCHBENCH_FWS_PORT:-}" ]]; then
        fuser -k -TERM "$((port + 1))/tcp" >/dev/null 2>&1 || true
      fi
    done
  fi
}

start_live_debug_tails() {
  mkdir -p "$(dirname "${PLUGIN_TRACE_FILE}")"
  : > "${PLUGIN_TRACE_FILE}"
  : > "${TRACE_LIVE_LOG_FILE}"
  : > "${GATEWAY_LIVE_LOG_FILE}"
  (
    stdbuf -oL tail -n 0 -F "${PLUGIN_TRACE_FILE}" 2>/dev/null \
      | python3 -u -c '
import json, sys
interesting = {
    "task_state_estimator_applied",
    "registry_driven_eviction_evaluated",
    "canonical_eviction_closure_checked",
    "canonical_eviction_applied",
    "canonical_state_sync",
    "canonical_state_rewrite",
}
for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    if obj.get("stage") not in interesting:
        continue
    print("[plugin-trace] " + json.dumps(obj, ensure_ascii=False), flush=True)
' \
      | if [[ "${LIVE_DEBUG_STDOUT}" == "true" ]]; then cat; else tee -a "${TRACE_LIVE_LOG_FILE}" >/dev/null; fi \
      || true
  ) &
  TRACE_TAIL_PID=$!

  touch "${GATEWAY_LOG_FILE}"
  (
    stdbuf -oL tail -n 0 -F "${GATEWAY_LOG_FILE}" 2>/dev/null \
      | python3 -u -c '
import sys
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if "tokenpilot" not in line.lower() and "plugin-runtime" not in line.lower():
        continue
    print("[gateway-log] " + line, flush=True)
' \
      | if [[ "${LIVE_DEBUG_STDOUT}" == "true" ]]; then cat; else tee -a "${GATEWAY_LIVE_LOG_FILE}" >/dev/null; fi \
      || true
  ) &
  GATEWAY_TAIL_PID=$!
}

BENCH_ARGS=(
  --model "${RESOLVED_MODEL}"
  --judge "${RESOLVED_JUDGE}"
  --suite "${RESOLVED_SUITE}"
  --runs "${RESOLVED_RUNS}"
  --parallel "${RESOLVED_PARALLEL}"
  --session-mode "${RESOLVED_SESSION_MODE}"
  --timeout-multiplier "${RESOLVED_TIMEOUT}"
  --output-dir "${OUTPUT_DIR}"
)
if [[ "${PHASE}" == "generate" ]]; then
  BENCH_ARGS+=(--generate-only)
fi
if [[ -n "${MAX_TASKS}" ]]; then
  BENCH_ARGS+=(--max-tasks "${MAX_TASKS}")
fi

DATASET_DIR="$(resolve_dataset_dir)"
cd "${DATASET_DIR}"
trap 'run_method_exit_cleanup' EXIT

if [[ "${PHASE}" == "eval" ]]; then
  RESULT_JSON="${INPUT_JSON:-$(latest_json_in_dir "${OUTPUT_DIR}" || true)}"
  if [[ -z "${RESULT_JSON}" ]]; then
    echo "Eval phase requires --input-json or an existing raw JSON in ${OUTPUT_DIR}" >&2
    exit 1
  fi
  uv run scripts/evaluate_raw.py \
    --input "${RESULT_JSON}" \
    --judge "${RESOLVED_JUDGE}" \
    2>&1 | tee "${RUN_LOG_FILE}"
else
  if [[ "${ENABLE_LIVE_DEBUG_TAILS}" =~ ^(true|1|yes)$ ]]; then
    log_runtime_step "start_live_debug_tails:start"
    start_live_debug_tails
    log_runtime_step "start_live_debug_tails:done"
  fi
  log_runtime_step "benchmark.py:start"
  uv run scripts/benchmark.py "${BENCH_ARGS[@]}" 2>&1 | tee "${RUN_LOG_FILE}"
  log_runtime_step "benchmark.py:done"
  cleanup_live_debug_tails
fi

echo "Run log saved to: ${RUN_LOG_FILE}"
if [[ -f "${TRACE_LIVE_LOG_FILE}" ]]; then
  echo "Plugin trace live log saved to: ${TRACE_LIVE_LOG_FILE}"
fi
if [[ -f "${GATEWAY_LIVE_LOG_FILE}" ]]; then
  echo "Gateway live log saved to: ${GATEWAY_LIVE_LOG_FILE}"
fi
if [[ -f "${EVAL_LOG_FILE}" ]]; then
  echo "Eval log saved to: ${EVAL_LOG_FILE}"
fi
if [[ -f "${EVAL_JSONL_FILE}" ]]; then
  echo "Eval jsonl saved to: ${EVAL_JSONL_FILE}"
fi

RESULT_JSON="${INPUT_JSON:-$(latest_json_in_dir "${OUTPUT_DIR}" || true)}"
if [[ -n "${RESULT_JSON}" ]]; then
  COST_REPORT_FILE="${REPORT_DIR}/method_${RUN_TAG}_cost.json"
  REDUCTION_TRACE_FILE="${PLUGIN_STATE_DIR}/tokenpilot/reduction-pass-trace.jsonl"
  if [[ ! -f "${REDUCTION_TRACE_FILE}" ]]; then
    REDUCTION_TRACE_FILE="${PLUGIN_STATE_DIR}/tokenpilot/reduction-pass-trace.jsonl"
  fi
  REDUCTION_REPORT_FILE="${REPORT_DIR}/method_${RUN_TAG}_reduction_passes.json"
  generate_cost_report_and_print_summary "${RESULT_JSON}" "${COST_REPORT_FILE}"
  generate_reduction_pass_report_and_print_summary "${REDUCTION_TRACE_FILE}" "${REDUCTION_REPORT_FILE}" "${RUN_START_ISO}"
else
  echo "Cost report skipped: no result JSON found in ${OUTPUT_DIR}" >&2
fi
