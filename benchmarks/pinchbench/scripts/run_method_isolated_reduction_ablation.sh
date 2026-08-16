#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINCHBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

METHOD_MODEL="${PINCHBENCH_METHOD_MODEL:-${TOKENPILOT_METHOD_MODEL:-${TOKENPILOT_MODEL:-tokenpilot/gpt-5.4-mini}}}"
METHOD_JUDGE="${PINCHBENCH_METHOD_JUDGE:-${TOKENPILOT_METHOD_JUDGE:-${TOKENPILOT_JUDGE:-gpt-5.4-mini}}}"
METHOD_SUITE="${PINCHBENCH_METHOD_SUITE:-${TOKENPILOT_SUITE:-automated-only}}"
METHOD_RUNS="${TOKENPILOT_RUNS:-1}"
METHOD_PARALLEL="${TOKENPILOT_PARALLEL:-1}"
METHOD_TIMEOUT="${TOKENPILOT_TIMEOUT_MULTIPLIER:-1.0}"
METHOD_PHASE="${TOKENPILOT_METHOD_PHASE:-full}"
METHOD_MAX_TASKS="${PINCHBENCH_METHOD_MAX_TASKS:-${PINCHBENCH_MAX_TASKS:-0}}"
VARIANT_FILTER="${PINCHBENCH_ISOLATED_ABLATION_VARIANTS:-no_reduction_pass}"

RUN_TAG="${PINCHBENCH_ISOLATED_ABLATION_RUN_TAG:-$(date +%Y%m%d_%H%M%S)}"
OUTPUT_ROOT="${PINCHBENCH_ISOLATED_ABLATION_OUTPUT_ROOT:-${PINCHBENCH_ROOT}/save/isolated_ablation/method}"
TMP_ROOT_BASE="${PINCHBENCH_ISOLATED_ABLATION_TMP_ROOT_BASE:-/tmp/pinchbench_isolated_ablation}"
SOURCE_OPENCLAW_HOME="${PINCHBENCH_SOURCE_OPENCLAW_HOME:-${HOME}}"
BASE_GATEWAY_PORT="${PINCHBENCH_ISOLATED_ABLATION_BASE_GATEWAY_PORT:-20889}"
BASE_PROXY_PORT="${PINCHBENCH_ISOLATED_ABLATION_BASE_PROXY_PORT:-19688}"
PINCHBENCH_FWS_SHARED_DATA_DIR="${PINCHBENCH_FWS_SHARED_DATA_DIR:-${HOME}/.local/share/fws}"
PINCHBENCH_GWS_SHARED_CONFIG_DIR="${PINCHBENCH_GWS_SHARED_CONFIG_DIR:-${HOME}/.local/share/fws/config}"

echo "[isolated-ablation] model=${METHOD_MODEL}"
echo "[isolated-ablation] judge=${METHOD_JUDGE}"
echo "[isolated-ablation] suite=${METHOD_SUITE}"
echo "[isolated-ablation] runs=${METHOD_RUNS}"
echo "[isolated-ablation] parallel=${METHOD_PARALLEL}"
echo "[isolated-ablation] phase=${METHOD_PHASE}"
echo "[isolated-ablation] max_tasks=${METHOD_MAX_TASKS}"
echo "[isolated-ablation] output_root=${OUTPUT_ROOT}"
echo "[isolated-ablation] run_tag=${RUN_TAG}"
echo "[isolated-ablation] variants=${VARIANT_FILTER}"

setup_variant_runtime() {
  local variant="$1"
  local index="$2"

  VARIANT_TMP_ROOT="${TMP_ROOT_BASE}/${RUN_TAG}/${variant}"
  VARIANT_OPENCLAW_HOME="${VARIANT_TMP_ROOT}/openclaw_home"
  VARIANT_OPENCLAW_CFG="${VARIANT_OPENCLAW_HOME}/.openclaw/openclaw.json"
  VARIANT_OPENCLAW_STATE_DIR="${VARIANT_OPENCLAW_HOME}/.openclaw"
  VARIANT_OPENCLAW_PROFILE="pinchbench-isolated-${RUN_TAG}-${variant}"
  VARIANT_GATEWAY_PORT="$((BASE_GATEWAY_PORT + index))"
  VARIANT_PROXY_PORT="$((BASE_PROXY_PORT + index))"
  VARIANT_FWS_DATA_DIR="${VARIANT_TMP_ROOT}/fws-shared"
  VARIANT_GWS_SOURCE_CONFIG_DIR="${VARIANT_TMP_ROOT}/gws-shared-config"

  echo "[isolated-ablation] variant=${variant} tmp_root=${VARIANT_TMP_ROOT}"
  echo "[isolated-ablation] variant=${variant} gateway_port=${VARIANT_GATEWAY_PORT} proxy_port=${VARIANT_PROXY_PORT}"

  if [[ -d "${VARIANT_TMP_ROOT}" ]]; then
    OPENCLAW_CONFIG_PATH="${VARIANT_OPENCLAW_CFG}" \
    OPENCLAW_STATE_DIR="${VARIANT_OPENCLAW_STATE_DIR}" \
    OPENCLAW_PROFILE="${VARIANT_OPENCLAW_PROFILE}" \
    OPENCLAW_GATEWAY_PORT="${VARIANT_GATEWAY_PORT}" \
    openclaw --profile "${VARIANT_OPENCLAW_PROFILE}" gateway stop >/dev/null 2>&1 || true
    rm -rf "${VARIANT_TMP_ROOT}"
  fi

  mkdir -p "${VARIANT_OPENCLAW_HOME}" "${VARIANT_FWS_DATA_DIR}" "${VARIANT_GWS_SOURCE_CONFIG_DIR}"

  if [[ -d "${PINCHBENCH_FWS_SHARED_DATA_DIR}" ]]; then
    cp -a "${PINCHBENCH_FWS_SHARED_DATA_DIR}/." "${VARIANT_FWS_DATA_DIR}/"
  fi
  if [[ -d "${PINCHBENCH_GWS_SHARED_CONFIG_DIR}" ]]; then
    cp -a "${PINCHBENCH_GWS_SHARED_CONFIG_DIR}/." "${VARIANT_GWS_SOURCE_CONFIG_DIR}/"
  fi

  if [[ ! -d "${SOURCE_OPENCLAW_HOME}/.openclaw" ]]; then
    echo "Missing source OpenClaw state dir: ${SOURCE_OPENCLAW_HOME}/.openclaw" >&2
    exit 1
  fi
  cp -a "${SOURCE_OPENCLAW_HOME}/.openclaw" "${VARIANT_OPENCLAW_HOME}/.openclaw"

  rm -rf "${VARIANT_OPENCLAW_STATE_DIR}/agents"
  mkdir -p "${VARIANT_OPENCLAW_STATE_DIR}/agents"
  rm -rf \
    "${VARIANT_OPENCLAW_STATE_DIR}/extensions/tokenpilot" \
    "${VARIANT_OPENCLAW_STATE_DIR}/tokenpilot-plugin-state"

  python3 - "${VARIANT_OPENCLAW_CFG}" "${METHOD_MODEL}" <<'PY'
import json
import sys

config_path = sys.argv[1]
method_model = sys.argv[2]

with open(config_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

agents = data.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
model_cfg = defaults.setdefault("model", {})
models_cfg = defaults.setdefault("models", {})
model_cfg["primary"] = method_model
model_cfg["fallbacks"] = []
if method_model not in models_cfg:
    models_cfg[method_model] = {}

plugins = data.setdefault("plugins", {})
plugins["allow"] = ["tokenpilot"]

entries = plugins.get("entries")
if isinstance(entries, dict):
    entries.pop("tokenpilot", None)
    if not entries:
        plugins.pop("entries", None)

installs = plugins.get("installs")
if isinstance(installs, dict):
    installs.pop("tokenpilot", None)
    if not installs:
        plugins.pop("installs", None)

load_cfg = plugins.get("load")
if isinstance(load_cfg, dict):
    paths = load_cfg.get("paths")
    if isinstance(paths, list):
        filtered = []
        for item in paths:
            if not isinstance(item, str):
                continue
            lowered = item.lower()
            if "/extensions/tokenpilot" in lowered:
                continue
            filtered.append(item)
        if filtered:
            load_cfg["paths"] = filtered
        else:
            plugins.pop("load", None)

with open(config_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

  (
    cd "${REPO_ROOT}"
    TOKENPILOT_OPENCLAW_HOME="${VARIANT_OPENCLAW_HOME}" \
    OPENCLAW_CONFIG_PATH="${VARIANT_OPENCLAW_CFG}" \
    OPENCLAW_STATE_DIR="${VARIANT_OPENCLAW_STATE_DIR}" \
    OPENCLAW_PROFILE="${VARIANT_OPENCLAW_PROFILE}" \
    OPENCLAW_GATEWAY_PORT="${VARIANT_GATEWAY_PORT}" \
    TOKENPILOT_PROXY_PORT="${VARIANT_PROXY_PORT}" \
    FWS_DATA_DIR="${VARIANT_FWS_DATA_DIR}" \
    GWS_SOURCE_CONFIG_DIR="${VARIANT_GWS_SOURCE_CONFIG_DIR}" \
    install_tokenpilot_runtime
  )
}

run_variant() {
  local variant="$1"
  local index="$2"
  local enable_passes="$3"
  local variant_output_dir="${OUTPUT_ROOT}/${RUN_TAG}/${variant}"

  echo
  echo "================================================================================"
  echo "[isolated-ablation] variant=${variant}"
  echo "[isolated-ablation] output_dir=${variant_output_dir}"
  echo "================================================================================"

  setup_variant_runtime "${variant}" "${index}"

  PINCHBENCH_TMP_ROOT="${VARIANT_TMP_ROOT}" \
  TOKENPILOT_OPENCLAW_HOME="${VARIANT_OPENCLAW_HOME}" \
  OPENCLAW_CONFIG_PATH="${VARIANT_OPENCLAW_CFG}" \
  OPENCLAW_STATE_DIR="${VARIANT_OPENCLAW_STATE_DIR}" \
  OPENCLAW_PROFILE="${VARIANT_OPENCLAW_PROFILE}" \
  OPENCLAW_GATEWAY_PORT="${VARIANT_GATEWAY_PORT}" \
  TOKENPILOT_GATEWAY_PORT="${VARIANT_GATEWAY_PORT}" \
  TOKENPILOT_PROXY_PORT="${VARIANT_PROXY_PORT}" \
  FWS_DATA_DIR="${VARIANT_FWS_DATA_DIR}" \
  GWS_SOURCE_CONFIG_DIR="${VARIANT_GWS_SOURCE_CONFIG_DIR}" \
  TOKENPILOT_FORCE_GATEWAY_RESTART=true \
  TOKENPILOT_SESSION_MODE=isolated \
  TOKENPILOT_ENABLE_REDUCTION=true \
  TOKENPILOT_ENABLE_EVICTION=false \
  TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED=false \
  TOKENPILOT_MEMORY_ENABLED=false \
  TOKENPILOT_MEMORY_AUTO_DISTILL=false \
  TOKENPILOT_MEMORY_TOP_K=0 \
  TOKENPILOT_REDUCTION_PASS_REPEATED_READ_DEDUP="${enable_passes}" \
  TOKENPILOT_REDUCTION_PASS_TOOL_PAYLOAD_TRIM="${enable_passes}" \
  TOKENPILOT_REDUCTION_PASS_HTML_SLIMMING="${enable_passes}" \
  TOKENPILOT_REDUCTION_PASS_EXEC_OUTPUT_TRUNCATION="${enable_passes}" \
  TOKENPILOT_REDUCTION_PASS_AGENTS_STARTUP_OPTIMIZATION="${enable_passes}" \
  TOKENPILOT_REDUCTION_PASS_FORMAT_SLIMMING="${enable_passes}" \
  TOKENPILOT_REDUCTION_PASS_FORMAT_CLEANING="${enable_passes}" \
  TOKENPILOT_REDUCTION_PASS_PATH_TRUNCATION="${enable_passes}" \
  TOKENPILOT_REDUCTION_PASS_IMAGE_DOWNSAMPLE="${enable_passes}" \
  TOKENPILOT_REDUCTION_PASS_LINE_NUMBER_STRIP="${enable_passes}" \
  "${SCRIPT_DIR}/run_method.sh" \
    --phase "${METHOD_PHASE}" \
    --model "${METHOD_MODEL}" \
    --judge "${METHOD_JUDGE}" \
    --suite "${METHOD_SUITE}" \
    --runs "${METHOD_RUNS}" \
    --parallel "${METHOD_PARALLEL}" \
    --timeout-multiplier "${METHOD_TIMEOUT}" \
    --session-mode isolated \
    --max-tasks "${METHOD_MAX_TASKS}" \
    --output-dir "${variant_output_dir}"
}

mkdir -p "${OUTPUT_ROOT}"

variant_enabled() {
  local target="$1"
  local raw="${VARIANT_FILTER}"
  IFS=',' read -r -a items <<< "${raw}"
  for item in "${items[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    [[ -z "${item}" ]] && continue
    if [[ "${item}" == "${target}" ]]; then
      return 0
    fi
  done
  return 1
}

if variant_enabled "no_reduction_pass"; then
  run_variant "no_reduction_pass" 1 false
fi

if variant_enabled "with_reduction_pass"; then
  run_variant "with_reduction_pass" 2 true
fi

echo
echo "[isolated-ablation] completed run_tag=${RUN_TAG}"
echo "[isolated-ablation] results_root=${OUTPUT_ROOT}/${RUN_TAG}"
