#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW_EVAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${CLAW_EVAL_REPO_ROOT}/../../.." && pwd)"

if [[ -f "${CLAW_EVAL_REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${CLAW_EVAL_REPO_ROOT}/.env"
  set +a
elif [[ -f "${CLAW_EVAL_REPO_ROOT}/../pinchbench/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${CLAW_EVAL_REPO_ROOT}/../pinchbench/.env"
  set +a
fi

ROOT_DIR="${PROJECT_ROOT}"
BENCH_PY="${CLAW_EVAL_REPO_ROOT}/scripts/benchmark.py"
TASKS_DIR="${CLAW_EVAL_REPO_ROOT}/dataset/tasks"
SOURCE_DIR="${CLAW_EVAL_REPO_ROOT}/vendor"

SOURCE_OPENCLAW_HOME="${SOURCE_OPENCLAW_HOME:-/home/xubuqiang}"
SOURCE_OPENCLAW_STATE_DIR="${SOURCE_OPENCLAW_STATE_DIR:-${SOURCE_OPENCLAW_HOME}/.openclaw}"
CATEGORY="${CLAW_EVAL_CATEGORY:-synthesis}"
MODEL="${CLAW_EVAL_MODEL:-tokenpilot/gpt-5.4-mini}"
JUDGE_MODEL="${CLAW_EVAL_JUDGE_MODEL:-${MODEL}}"
LOG_FILE="${CLAW_EVAL_LOG_FILE:-${ROOT_DIR}/claw_eval_continuous_${CATEGORY}_plugin_tmpconfig.log}"
PID_FILE="${CLAW_EVAL_PID_FILE:-${ROOT_DIR}/claw_eval_continuous_${CATEGORY}_plugin_tmpconfig.pid}"
EXTRA_ARGS="${CLAW_EVAL_EXTRA_ARGS:-}"
CPUSET="${CPUSET:-}"
NICE_LEVEL="${NICE_LEVEL:-}"
TMP_GATEWAY_LOG_FILE=""
TMP_GATEWAY_PID_FILE=""
TMP_GATEWAY_PORT=""
TMP_PROXY_PORT=""

export CLAW_EVAL_SOURCE_ROOT="${CLAW_EVAL_SOURCE_ROOT:-${SOURCE_DIR}}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/uv-cache}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
export CLAW_EVAL_AGENT_TIMEOUT_SECONDS="${CLAW_EVAL_AGENT_TIMEOUT_SECONDS:-0}"

# Continuous plugin policy: reduction + eviction + estimator enabled.
export TOKENPILOT_ENABLE_REDUCTION="${TOKENPILOT_ENABLE_REDUCTION:-true}"
export TOKENPILOT_ENABLE_EVICTION="${TOKENPILOT_ENABLE_EVICTION:-true}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED="${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED:-true}"
export TOKENPILOT_FORCE_GATEWAY_RESTART="${TOKENPILOT_FORCE_GATEWAY_RESTART:-false}"

BATCH_TURNS="${CLAW_EVAL_BATCH_TURNS:-3}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS="${TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS:-${BATCH_TURNS}}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE="${TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE:-decoupled}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY:-fifo}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE:-1}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL="${TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL:-https://www.dmxapi.cn/v1}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL="${TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL:-qwen3.5-35b-a3b}"

if [[ "${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED}" == "true" && -z "${TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY:-}" ]]; then
  echo "Missing TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY in environment." >&2
  exit 2
fi

mkdir -p "$(dirname "${LOG_FILE}")" "$XDG_CACHE_HOME" "$UV_CACHE_DIR"

prepare_tmp_openclaw_home() {
  if [[ ! -d "${SOURCE_OPENCLAW_STATE_DIR}" ]]; then
    echo "Missing source OpenClaw state dir: ${SOURCE_OPENCLAW_STATE_DIR}" >&2
    exit 2
  fi

  local run_stamp tmp_home tmp_state
  run_stamp="$(date +%Y%m%d_%H%M%S)_$$"
  tmp_home="/tmp/claw-eval-openclaw-${CATEGORY}-${run_stamp}"
  tmp_state="${tmp_home}/.openclaw"

  mkdir -p "${tmp_home}"
  cp -a "${SOURCE_OPENCLAW_STATE_DIR}" "${tmp_state}"

  # Start from a clean runtime state so old proxy traces, sessions, and plugin
  # caches do not leak into the smoke run.
  rm -rf \
    "${tmp_state}/tokenpilot-plugin-state" \
    "${tmp_state}/ecoclaw-plugin-state" \
    "${tmp_state}/logs" \
    "${tmp_state}/completions" \
    "${tmp_state}/canvas" \
    "${tmp_state}/cron" \
    "${tmp_state}/workspace" \
    "${tmp_state}/agents"
  mkdir -p "${tmp_state}/agents"

  export TOKENPILOT_OPENCLAW_HOME="${tmp_home}"
  export OPENCLAW_CONFIG_PATH="${tmp_state}/openclaw.json"
  export HOME="${tmp_home}"
  export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${tmp_home}/.config}"
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${tmp_home}/.cache}"

  TMP_GATEWAY_PORT="$(python3 - <<'PY'
import socket
s=socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
  TMP_PROXY_PORT="$(python3 - <<'PY'
import socket
s=socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
  export ECOCLAW_GATEWAY_PORT="${TMP_GATEWAY_PORT}"
  python3 - "${OPENCLAW_CONFIG_PATH}" "${TMP_GATEWAY_PORT}" "${TMP_PROXY_PORT}" <<'PY'
import json
import sys
from pathlib import Path
p=Path(sys.argv[1])
gateway_port=int(sys.argv[2])
proxy_port=int(sys.argv[3])
obj=json.loads(p.read_text(encoding='utf-8'))
obj.setdefault("gateway", {})["port"] = gateway_port
plugins = obj.setdefault("plugins", {})
entries = plugins.setdefault("entries", {})
tokenpilot = entries.setdefault("tokenpilot", {})
tokenpilot_cfg = tokenpilot.setdefault("config", {})
tokenpilot_cfg["proxyPort"] = proxy_port
p.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

  TMP_GATEWAY_LOG_FILE="${tmp_home}/gateway.log"
  TMP_GATEWAY_PID_FILE="${tmp_home}/gateway.pid"

  echo "[tmp-openclaw] source=${SOURCE_OPENCLAW_STATE_DIR}"
  echo "[tmp-openclaw] home=${tmp_home}"
  echo "[tmp-openclaw] config=${OPENCLAW_CONFIG_PATH}"
  echo "[tmp-openclaw] gateway_port=${TMP_GATEWAY_PORT}"
  echo "[tmp-openclaw] proxy_port=${TMP_PROXY_PORT}"
}

start_tmp_gateway() {
  : "${TMP_GATEWAY_PORT:?missing TMP_GATEWAY_PORT}"
  : "${TMP_PROXY_PORT:?missing TMP_PROXY_PORT}"
  : "${TMP_GATEWAY_LOG_FILE:?missing TMP_GATEWAY_LOG_FILE}"
  : "${TMP_GATEWAY_PID_FILE:?missing TMP_GATEWAY_PID_FILE}"

  nohup env \
    HOME="${HOME}" \
    OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}" \
    XDG_CACHE_HOME="${XDG_CACHE_HOME}" \
    XDG_CONFIG_HOME="${XDG_CONFIG_HOME}" \
    TOKENPILOT_OPENCLAW_HOME="${TOKENPILOT_OPENCLAW_HOME}" \
    TOKENPILOT_UPSTREAM_HTTP_PROXY="${TOKENPILOT_UPSTREAM_HTTP_PROXY:-}" \
    TOKENPILOT_UPSTREAM_HTTPS_PROXY="${TOKENPILOT_UPSTREAM_HTTPS_PROXY:-}" \
    TOKENPILOT_UPSTREAM_NO_PROXY="${TOKENPILOT_UPSTREAM_NO_PROXY:-}" \
    openclaw gateway run --force --port "${TMP_GATEWAY_PORT}" >"${TMP_GATEWAY_LOG_FILE}" 2>&1 &
  local gateway_pid=$!
  echo "${gateway_pid}" > "${TMP_GATEWAY_PID_FILE}"

  local attempts=0
  while [[ ${attempts} -lt 30 ]]; do
    if python3 - "${TMP_GATEWAY_PORT}" "${TMP_PROXY_PORT}" <<'PY' >/dev/null 2>&1
import socket
import sys

ports = [int(sys.argv[1]), int(sys.argv[2])]
for port in ports:
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", port))
    finally:
        s.close()
PY
    then
      echo "[tmp-openclaw] gateway_ready pid=${gateway_pid} gateway_port=${TMP_GATEWAY_PORT} proxy_port=${TMP_PROXY_PORT}"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done

  echo "Failed to start tmp OpenClaw gateway. See ${TMP_GATEWAY_LOG_FILE}" >&2
  tail -n 120 "${TMP_GATEWAY_LOG_FILE}" >&2 || true
  return 1
}

stop_tmp_gateway() {
  if [[ -n "${TMP_GATEWAY_PID_FILE}" && -f "${TMP_GATEWAY_PID_FILE}" ]]; then
    local pid
    pid="$(cat "${TMP_GATEWAY_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" 2>/dev/null || true
    fi
  fi
}

run_foreground() {
  prepare_tmp_openclaw_home
  start_tmp_gateway
  trap stop_tmp_gateway EXIT
  cd "${ROOT_DIR}"
  exec uv run --directory "${SOURCE_DIR}" --extra mock python -u "${BENCH_PY}" \
    --tasks-dir "${TASKS_DIR}" \
    --suite "${CATEGORY}" \
    --session-mode continuous \
    --parallel 1 \
    --model "${MODEL}" \
    --judge "${JUDGE_MODEL}" \
    --openclaw-config-path "${OPENCLAW_CONFIG_PATH}" \
    --apply-plugin-plan \
    --execute-tasks \
    ${EXTRA_ARGS}
}

if [[ "${1:-}" == "--foreground" ]]; then
  run_foreground
  exit 0
fi

launcher=()
if [[ -n "${CPUSET}" ]]; then
  launcher+=(taskset -c "${CPUSET}")
fi
if [[ -n "${NICE_LEVEL}" ]]; then
  launcher+=(nice -n "${NICE_LEVEL}")
fi
launcher+=(bash "$0" --foreground)
nohup "${launcher[@]}" > "${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
echo "started claw-eval continuous category tmpconfig run"
echo "category=${CATEGORY}"
echo "pid=$(cat "${PID_FILE}")"
echo "log=${LOG_FILE}"
echo "model=${MODEL}"
