#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[pinchbench] scripts/run.sh is a convenience wrapper for the experiment matrix."
echo "[pinchbench] For canonical single-run entrypoints, use scripts/run_baseline.sh or scripts/run_method.sh."

TOKENPILOT_MATRIX_SUITE="${TOKENPILOT_MATRIX_SUITE:-all}" \
TOKENPILOT_MATRIX_CONTINUOUS_RUNS="${TOKENPILOT_MATRIX_CONTINUOUS_RUNS:-1}" \
TOKENPILOT_MATRIX_ISOLATED_RUNS="${TOKENPILOT_MATRIX_ISOLATED_RUNS:-1}" \
bash "${SCRIPT_DIR}/run_experiment_matrix.sh"
