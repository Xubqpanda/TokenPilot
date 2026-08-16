#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINCHBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${PINCHBENCH_ROOT}/save/logs"
RUN_TAG="$(date +%Y%m%d_%H%M%S)"
PLAN_LOG="${LOG_DIR}/matrix_${RUN_TAG}.log"
MATRIX_OUTPUT_ROOT="${TOKENPILOT_MATRIX_OUTPUT_ROOT:-${PINCHBENCH_ROOT}/save/matrix}"

mkdir -p "${LOG_DIR}"
touch "${PLAN_LOG}"

SUITE="${TOKENPILOT_MATRIX_SUITE:-automated-only}"
METHOD_MODEL="${TOKENPILOT_MATRIX_METHOD_MODEL:-${TOKENPILOT_MODEL:-tokenpilot/gpt-5.4-mini}}"
METHOD_JUDGE="${TOKENPILOT_MATRIX_METHOD_JUDGE:-${TOKENPILOT_JUDGE:-tokenpilot/gpt-5.4-mini}}"
BASELINE_MODEL="${TOKENPILOT_MATRIX_BASELINE_MODEL:-${TOKENPILOT_BASELINE_MODEL:-gpt-5.4-mini}}"
BASELINE_JUDGE="${TOKENPILOT_MATRIX_BASELINE_JUDGE:-${TOKENPILOT_BASELINE_JUDGE:-gpt-5.4-mini}}"
RUNS_CONT="${TOKENPILOT_MATRIX_CONTINUOUS_RUNS:-1}"
RUNS_ISO="${TOKENPILOT_MATRIX_ISOLATED_RUNS:-1}"
TIMEOUT_MULTIPLIER="${TOKENPILOT_MATRIX_TIMEOUT_MULTIPLIER:-1.0}"
PARALLEL="${TOKENPILOT_MATRIX_PARALLEL:-1}"
MATRIX_PHASE="${TOKENPILOT_MATRIX_PHASE:-full}"

log() {
  printf '[matrix] %s\n' "$*" | tee -a "${PLAN_LOG}"
}

run_method_case() {
  local name="${1:?case name required}"
  shift
  local case_slug
  case_slug="$(printf '%s' "${name}" | tr '/=+' '___' | tr -c 'A-Za-z0-9._-' '_')"
  local case_output_dir="${MATRIX_OUTPUT_ROOT}/${case_slug}"
  log "START ${name}"
  (
    set -euo pipefail
    for env_kv in "$@"; do
      export "${env_kv}"
    done
    "${SCRIPT_DIR}/run_method.sh" \
      --phase "${MATRIX_PHASE}" \
      --model "${METHOD_MODEL}" \
      --judge "${METHOD_JUDGE}" \
      --suite "${SUITE}" \
      --runs "${CURRENT_RUNS}" \
      --timeout-multiplier "${TIMEOUT_MULTIPLIER}" \
      --parallel "${PARALLEL}" \
      --session-mode "${CURRENT_SESSION_MODE}" \
      --output-dir "${case_output_dir}"
  )
  log "DONE  ${name}"
}

run_baseline_case() {
  local name="${1:?case name required}"
  shift
  local case_slug
  case_slug="$(printf '%s' "${name}" | tr '/=+' '___' | tr -c 'A-Za-z0-9._-' '_')"
  local case_output_dir="${MATRIX_OUTPUT_ROOT}/${case_slug}"
  log "START ${name}"
  (
    set -euo pipefail
    for env_kv in "$@"; do
      export "${env_kv}"
    done
    "${SCRIPT_DIR}/run_baseline.sh" \
      --phase "${MATRIX_PHASE}" \
      --model "${BASELINE_MODEL}" \
      --judge "${BASELINE_JUDGE}" \
      --suite "${SUITE}" \
      --runs "${CURRENT_RUNS}" \
      --timeout-multiplier "${TIMEOUT_MULTIPLIER}" \
      --parallel "${PARALLEL}" \
      --session-mode "${CURRENT_SESSION_MODE}" \
      --output-dir "${case_output_dir}"
  )
  log "DONE  ${name}"
}

log "Plan log: ${PLAN_LOG}"
log "suite=${SUITE} method_model=${METHOD_MODEL} baseline_model=${BASELINE_MODEL}"
log "phase=${MATRIX_PHASE}"
log "Assumptions: baseline=no estimator/no reduction/no eviction; stability+reduction=reduction only; fifo variants=estimator+reduction+eviction with decoupled FIFO."

CURRENT_SESSION_MODE="continuous"
CURRENT_RUNS="${RUNS_CONT}"

for batch in 1 2 3 4 5; do
  run_method_case \
    "continuous/method/stability+reduction+fifo/batch=${batch}" \
    "TOKENPILOT_SESSION_MODE=${CURRENT_SESSION_MODE}" \
    "TOKENPILOT_RUNS=${CURRENT_RUNS}" \
    "TOKENPILOT_ENABLE_REDUCTION=true" \
    "TOKENPILOT_ENABLE_EVICTION=true" \
    "TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED=true" \
    "TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS=${batch}" \
    "TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE=decoupled" \
    "TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY=fifo" \
    "TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE=1"
done

run_method_case \
  "continuous/method/stability+reduction" \
  "TOKENPILOT_SESSION_MODE=${CURRENT_SESSION_MODE}" \
  "TOKENPILOT_RUNS=${CURRENT_RUNS}" \
  "TOKENPILOT_ENABLE_REDUCTION=true" \
  "TOKENPILOT_ENABLE_EVICTION=false" \
  "TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED=false"

run_baseline_case \
  "continuous/baseline" \
  "TOKENPILOT_BASELINE_SESSION_MODE=${CURRENT_SESSION_MODE}" \
  "TOKENPILOT_BASELINE_RUNS=${CURRENT_RUNS}"

CURRENT_SESSION_MODE="isolated"
CURRENT_RUNS="${RUNS_ISO}"

run_baseline_case \
  "isolated/baseline" \
  "TOKENPILOT_BASELINE_SESSION_MODE=${CURRENT_SESSION_MODE}" \
  "TOKENPILOT_BASELINE_RUNS=${CURRENT_RUNS}"

run_method_case \
  "isolated/method/stability+reduction" \
  "TOKENPILOT_SESSION_MODE=${CURRENT_SESSION_MODE}" \
  "TOKENPILOT_RUNS=${CURRENT_RUNS}" \
  "TOKENPILOT_ENABLE_REDUCTION=true" \
  "TOKENPILOT_ENABLE_EVICTION=false" \
  "TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED=false"

log "ALL DONE"
