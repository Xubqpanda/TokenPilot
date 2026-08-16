#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

DEFAULT_SUITE="task_market_research,task_polymarket_briefing"

METHOD_MODEL="${METHOD_MODEL:-gpt-5.4-mini}"
METHOD_JUDGE="${METHOD_JUDGE:-gpt-5.4-mini}"
METHOD_SUITE="${METHOD_SUITE:-${DEFAULT_SUITE}}"
METHOD_PARALLEL="${METHOD_PARALLEL:-1}"
METHOD_RUNS="${METHOD_RUNS:-1}"
METHOD_TIMEOUT_MULTIPLIER="${METHOD_TIMEOUT_MULTIPLIER:-1.0}"
METHOD_MAX_TASKS="${METHOD_MAX_TASKS:-}"
NOHUP_LOG_DIR="${NOHUP_LOG_DIR:-/tmp}"

mkdir -p "${NOHUP_LOG_DIR}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUT_LOG="${NOHUP_LOG_DIR}/pinchbench_method_with_reduction_regression_${TIMESTAMP}.out"
PID_FILE="${NOHUP_LOG_DIR}/pinchbench_method_with_reduction_regression_${TIMESTAMP}.pid"

cd "${REPO_ROOT}"

nohup bash -lc "
set -euo pipefail
cd '${REPO_ROOT}'
set -a
source '${REPO_ROOT}/benchmarks/pinchbench/.env'
set +a
PINCHBENCH_ISOLATED_ABLATION_VARIANTS='with_reduction_pass' \\
PINCHBENCH_METHOD_MODEL='${METHOD_MODEL}' \\
PINCHBENCH_METHOD_JUDGE='${METHOD_JUDGE}' \\
PINCHBENCH_METHOD_SUITE='${METHOD_SUITE}' \\
TOKENPILOT_PARALLEL='${METHOD_PARALLEL}' \\
TOKENPILOT_RUNS='${METHOD_RUNS}' \\
TOKENPILOT_TIMEOUT_MULTIPLIER='${METHOD_TIMEOUT_MULTIPLIER}' \\
$(if [[ -n "${METHOD_MAX_TASKS}" ]]; then printf "PINCHBENCH_METHOD_MAX_TASKS='%s' \\\\\n" "${METHOD_MAX_TASKS}"; fi)bash '${REPO_ROOT}/benchmarks/pinchbench/scripts/run_method_isolated_reduction_ablation.sh'
" >"${OUT_LOG}" 2>&1 < /dev/null &

PID=$!
echo "${PID}" > "${PID_FILE}"

echo "Started method regression run (with_reduction_pass)"
echo "PID: ${PID}"
echo "PID file: ${PID_FILE}"
echo "Log: ${OUT_LOG}"
echo "Suite: ${METHOD_SUITE}"
