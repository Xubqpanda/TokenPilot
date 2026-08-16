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
PROFILE=""
BY_CATEGORY="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      printf 'Usage: %s [--scope suite|general|category] [--session-mode isolated|continuous] [--profile plugin] [options]\n' "$0"
      printf 'Requires TOKENPILOT_RUNTIME_ROOT and model/provider credentials.\n'
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
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --tmp-openclaw) TMP_OPENCLAW="true"; shift ;;
    --by-category) BY_CATEGORY="true"; shift ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

ce_import_runtime_envs
PROFILE_MODE="${SESSION_MODE:-${TOKENPILOT_SESSION_MODE:-continuous}}"
load_benchmark_profile tokenpilot "${PROFILE_MODE}"
ce_normalize_runtime_env
ce_install_release_plugin

RESOLVED_MODEL="${MODEL:-${CLAW_EVAL_METHOD_MODEL:-${CLAW_EVAL_MODEL:-tokenpilot/gpt-5.4-mini}}}"
RESOLVED_JUDGE="${JUDGE:-${CLAW_EVAL_METHOD_JUDGE:-${CLAW_EVAL_JUDGE_MODEL:-${RESOLVED_MODEL}}}}"
RESOLVED_SCOPE="${SCOPE:-${CLAW_EVAL_METHOD_SCOPE:-general}}"
RESOLVED_SESSION_MODE="${SESSION_MODE:-${CLAW_EVAL_METHOD_SESSION_MODE:-continuous}}"
RESOLVED_PARALLEL="${PARALLEL:-${CLAW_EVAL_METHOD_PARALLEL:-1}}"
RESOLVED_PROFILE="${PROFILE:-${CLAW_EVAL_METHOD_PROFILE:-plugin}}"
RESOLVED_OUTPUT_DIR="${OUTPUT_DIR_OVERRIDE:-${CLAW_EVAL_ROOT}/save/tokenpilot/${RESOLVED_SESSION_MODE}}"

ce_apply_method_profile "${RESOLVED_PROFILE}"
ce_require_estimator_env_if_enabled

cd "${PROJECT_ROOT}"

if [[ "${BY_CATEGORY}" == "true" ]]; then
  if [[ "${RESOLVED_SCOPE}" != "general" ]]; then
    echo "--by-category currently supports only --scope general" >&2
    exit 1
  fi
  while IFS=$'\t' read -r row_category row_suite; do
    [[ -z "${row_category}" ]] && continue
    echo "[category] ${row_category}"
    if [[ "${TMP_OPENCLAW}" == "true" ]]; then
      ce_prepare_tmp_openclaw_home "method-${row_category}"
    fi
    ce_run_benchmark \
      "${row_suite}" \
      "${RESOLVED_SESSION_MODE}" \
      "${RESOLVED_MODEL}" \
      "${RESOLVED_JUDGE}" \
      "${RESOLVED_OUTPUT_DIR}" \
      "${PHASE}" \
      "${RESOLVED_PARALLEL}" \
      "${MAX_TASKS}"
  done <<< "$(ce_general_category_rows)"
  exit 0
fi

if [[ "${TMP_OPENCLAW}" == "true" ]]; then
  ce_prepare_tmp_openclaw_home "method-${RESOLVED_SCOPE}"
fi

RESOLVED_SUITE="$(ce_scope_to_suite "${RESOLVED_SCOPE}" "${SUITE}" "${CATEGORY}")"

ce_run_benchmark \
  "${RESOLVED_SUITE}" \
  "${RESOLVED_SESSION_MODE}" \
  "${RESOLVED_MODEL}" \
  "${RESOLVED_JUDGE}" \
  "${RESOLVED_OUTPUT_DIR}" \
  "${PHASE}" \
  "${RESOLVED_PARALLEL}" \
  "${MAX_TASKS}"
