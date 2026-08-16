#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

MODEL=""
JUDGE=""
SCOPE=""
SUITE=""
CATEGORY=""
SESSION_MODE=""
PARALLEL=""
PHASE="full"
OUTPUT_DIR_OVERRIDE=""
MAX_TASKS="0"
TMP_OPENCLAW="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      printf 'Usage: %s [--scope suite|general|category] [--session-mode isolated|continuous] [options]\n' "$0"
      exit 0
      ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --judge) JUDGE="${2:-}"; shift 2 ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --suite) SUITE="${2:-}"; shift 2 ;;
    --category) CATEGORY="${2:-}"; shift 2 ;;
    --session-mode) SESSION_MODE="${2:-}"; shift 2 ;;
    --parallel) PARALLEL="${2:-}"; shift 2 ;;
    --phase) PHASE="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR_OVERRIDE="${2:-}"; shift 2 ;;
    --max-tasks) MAX_TASKS="${2:-}"; shift 2 ;;
    --tmp-openclaw) TMP_OPENCLAW="true"; shift ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

ce_import_runtime_envs
PROFILE_MODE="${SESSION_MODE:-${TOKENPILOT_SESSION_MODE:-isolated}}"
load_benchmark_profile baseline "${PROFILE_MODE}"
ce_normalize_runtime_env
ce_apply_baseline_profile

RESOLVED_MODEL="${MODEL:-${CLAW_EVAL_BASELINE_MODEL:-${CLAW_EVAL_MODEL:-gpt-5.4-mini}}}"
RESOLVED_JUDGE="${JUDGE:-${CLAW_EVAL_BASELINE_JUDGE:-${CLAW_EVAL_JUDGE_MODEL:-${RESOLVED_MODEL}}}}"
RESOLVED_SCOPE="${SCOPE:-${CLAW_EVAL_BASELINE_SCOPE:-general}}"
RESOLVED_SESSION_MODE="${SESSION_MODE:-${CLAW_EVAL_BASELINE_SESSION_MODE:-isolated}}"
RESOLVED_PARALLEL="${PARALLEL:-${CLAW_EVAL_BASELINE_PARALLEL:-1}}"
RESOLVED_OUTPUT_DIR="${OUTPUT_DIR_OVERRIDE:-${CLAW_EVAL_ROOT}/save/baseline/${RESOLVED_SESSION_MODE}}"

if [[ "${TMP_OPENCLAW}" == "true" ]]; then
  ce_prepare_tmp_openclaw_home "baseline-${RESOLVED_SCOPE}"
fi

RESOLVED_SUITE="$(ce_scope_to_suite "${RESOLVED_SCOPE}" "${SUITE}" "${CATEGORY}")"

cd "${PROJECT_ROOT}"
ce_run_benchmark \
  "${RESOLVED_SUITE}" \
  "${RESOLVED_SESSION_MODE}" \
  "${RESOLVED_MODEL}" \
  "${RESOLVED_JUDGE}" \
  "${RESOLVED_OUTPUT_DIR}" \
  "${PHASE}" \
  "${RESOLVED_PARALLEL}" \
  "${MAX_TASKS}"
