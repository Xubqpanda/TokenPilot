#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINCHBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

MODEL=""
JUDGE=""
SUITE=""
RUNS=""
TIMEOUT_MULTIPLIER=""
PARALLEL=""
SESSION_MODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="${2:-}"; shift 2 ;;
    --judge) JUDGE="${2:-}"; shift 2 ;;
    --suite) SUITE="${2:-}"; shift 2 ;;
    --runs) RUNS="${2:-}"; shift 2 ;;
    --timeout-multiplier) TIMEOUT_MULTIPLIER="${2:-}"; shift 2 ;;
    --parallel) PARALLEL="${2:-}"; shift 2 ;;
    --session-mode) SESSION_MODE="${2:-}"; shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

import_runtime_envs
MODEL_LIKE="${MODEL:-${TOKENPILOT_BASELINE_MODEL:-${BASELINE_MODEL:-gpt-5.4-mini}}}"
JUDGE_LIKE="${JUDGE:-${TOKENPILOT_BASELINE_JUDGE:-${BASELINE_JUDGE:-gpt-5.4-mini}}}"
apply_model_runtime_env "${MODEL_LIKE}"
require_method_runtime_env
apply_ecoclaw_env
recover_stale_openclaw_config_backup

if [[ -z "${PINCHBENCH_DATASET_DIR:-}" && -d "${PINCHBENCH_ROOT}/dataset" ]]; then
  export PINCHBENCH_DATASET_DIR="${PINCHBENCH_ROOT}/dataset"
fi

RESOLVED_MODEL="$(resolve_model_alias "${MODEL_LIKE}")"
RESOLVED_JUDGE="$(resolve_model_alias "${JUDGE_LIKE}")"
RESOLVED_SUITE="${SUITE:-${TOKENPILOT_BASELINE_SUITE:-${BASELINE_SUITE:-${TOKENPILOT_SUITE:-${ECOCLAW_SUITE:-automated-only}}}}}"
RESOLVED_RUNS="${RUNS:-${TOKENPILOT_BASELINE_RUNS:-${BASELINE_RUNS:-${TOKENPILOT_RUNS:-${ECOCLAW_RUNS:-1}}}}}"
RESOLVED_TIMEOUT="${TIMEOUT_MULTIPLIER:-${TOKENPILOT_BASELINE_TIMEOUT_MULTIPLIER:-${BASELINE_TIMEOUT_MULTIPLIER:-${TOKENPILOT_TIMEOUT_MULTIPLIER:-${ECOCLAW_TIMEOUT_MULTIPLIER:-1.0}}}}}"
RESOLVED_PARALLEL="${PARALLEL:-${TOKENPILOT_BASELINE_PARALLEL:-${BASELINE_PARALLEL:-${TOKENPILOT_PARALLEL:-${ECOCLAW_PARALLEL:-1}}}}}"
RESOLVED_SESSION_MODE="${SESSION_MODE:-${TOKENPILOT_BASELINE_SESSION_MODE:-${BASELINE_SESSION_MODE:-${TOKENPILOT_SESSION_MODE:-${ECOCLAW_SESSION_MODE:-isolated}}}}}"

configure_baseline_runtime() {
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  local baseline_base_url="${BASELINE_BASE_URL:-${ECOCLAW_BASE_URL:-}}"
  local baseline_api_key="${BASELINE_API_KEY:-${ECOCLAW_API_KEY:-}}"
  local provider_name="${BASELINE_PROVIDER_PREFIX:-${PINCHBENCH_MODEL_PROVIDER_PREFIX:-${ECOCLAW_OPENAI_PROVIDER:-}}}"
  local resolved_model="${1:?resolved model is required}"
  local resolved_judge="${2:?resolved judge is required}"
  if [[ ! -f "${config_path}" ]]; then
    echo "WARN: openclaw config not found, skip baseline runtime patch: ${config_path}" >&2
    return 0
  fi
  if [[ -z "${baseline_base_url}" || -z "${baseline_api_key}" ]]; then
    echo "Missing baseline base URL or API key." >&2
    return 1
  fi
  if [[ "${resolved_model}" == */* ]]; then
    provider_name="${resolved_model%%/*}"
  elif [[ -z "${provider_name}" ]]; then
    echo "Baseline provider prefix is required when model is not fully qualified." >&2
    return 1
  fi
  if [[ -z "${provider_name}" ]]; then
    echo "Unable to infer baseline provider prefix." >&2
    return 1
  fi
  local model_id="${resolved_model##*/}"
  local judge_id="${resolved_judge##*/}"

  python3 - "${config_path}" "${baseline_base_url}" "${baseline_api_key}" "${provider_name}" "${model_id}" "${judge_id}" <<'BASELINE_PY'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
baseline_base_url = sys.argv[2]
baseline_api_key = sys.argv[3]
provider_name = sys.argv[4]
model_id = sys.argv[5]
judge_id = sys.argv[6]
obj = json.loads(config_path.read_text(encoding="utf-8"))

plugins = obj.setdefault("plugins", {})
entries = plugins.setdefault("entries", {})
slots = plugins.setdefault("slots", {})
eco = entries.setdefault("ecoclaw", {})
eco["enabled"] = False
slots["contextEngine"] = "legacy"

models = obj.setdefault("models", {})
providers = models.setdefault("providers", {})
provider = providers.setdefault(provider_name, {})
provider["baseUrl"] = baseline_base_url
provider["apiKey"] = baseline_api_key
provider["api"] = "openai-completions"

existing = {
    str(item.get("id") or ""): item
    for item in (provider.get("models") or [])
    if isinstance(item, dict)
}
for candidate in {model_id, judge_id}:
    if not candidate:
        continue
    existing[candidate] = {
        "id": candidate,
        "name": candidate,
        "api": "openai-completions",
        "reasoning": False,
        "input": ["text", "image"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 500000,
        "maxTokens": 16384,
    }
provider["models"] = list(existing.values())

config_path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")
BASELINE_PY
}

backup_openclaw_config
configure_baseline_runtime "${RESOLVED_MODEL}" "${RESOLVED_JUDGE}"
validate_openclaw_runtime_config
ECOCLAW_FORCE_GATEWAY_RESTART="${TOKENPILOT_FORCE_GATEWAY_RESTART:-${ECOCLAW_FORCE_GATEWAY_RESTART:-true}}" ensure_openclaw_gateway_running

OUTPUT_DIR="${PINCHBENCH_ROOT}/save/${RESOLVED_SESSION_MODE}/baseline/raw"
LOG_DIR="${PINCHBENCH_ROOT}/save/logs"
REPORT_DIR="${PINCHBENCH_ROOT}/save/reports"
RUN_TAG="$(date +%Y%m%d_%H%M%S)"
RUN_LOG_FILE="${LOG_DIR}/pinchbench_baseline_${RUN_TAG}.log"
BENCHMARK_LOG_FILE="${LOG_DIR}/pinchbench_baseline_${RUN_TAG}_benchmark.log"
RUN_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "${OUTPUT_DIR}" "${LOG_DIR}" "${REPORT_DIR}"

restore_baseline_runtime() {
  restore_openclaw_config || true
  ECOCLAW_FORCE_GATEWAY_RESTART="${TOKENPILOT_FORCE_GATEWAY_RESTART:-${ECOCLAW_FORCE_GATEWAY_RESTART:-true}}" ensure_openclaw_gateway_running >/dev/null 2>&1 || true
}
trap restore_baseline_runtime EXIT

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

DATASET_DIR="$(resolve_dataset_dir)"
cd "${DATASET_DIR}"
uv run scripts/benchmark.py "${BENCH_ARGS[@]}" 2>&1 | tee "${RUN_LOG_FILE}"

if [[ -f "${DATASET_DIR}/benchmark.log" ]]; then
  cp "${DATASET_DIR}/benchmark.log" "${BENCHMARK_LOG_FILE}"
fi

echo "Run log saved to: ${RUN_LOG_FILE}"
if [[ -f "${BENCHMARK_LOG_FILE}" ]]; then
  echo "Benchmark log saved to: ${BENCHMARK_LOG_FILE}"
fi

RESULT_JSON="$(latest_json_in_dir "${OUTPUT_DIR}" || true)"
if [[ -n "${RESULT_JSON}" ]]; then
  COST_REPORT_FILE="${REPORT_DIR}/baseline_${RUN_TAG}_cost.json"
  generate_cost_report_and_print_summary "${RESULT_JSON}" "${COST_REPORT_FILE}"
else
  echo "Cost report skipped: no result JSON found in ${OUTPUT_DIR}" >&2
fi
