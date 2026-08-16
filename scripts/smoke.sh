#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ "${1:-}" == "--runtime" ]]; then
  export TOKENPILOT_RUNTIME_ROOT="${2:?--runtime requires a LightMem2 checkout}"
fi

printf '[smoke] shell syntax\n'
while IFS= read -r script; do
  bash -n "${script}"
done < <(find "${REPO_ROOT}/benchmarks" "${REPO_ROOT}/runtime" "${REPO_ROOT}/shared" -type f -name '*.sh' | sort)

printf '[smoke] runner help\n'
bash "${REPO_ROOT}/benchmarks/pinchbench/scripts/run_baseline.sh" --help >/dev/null
bash "${REPO_ROOT}/benchmarks/pinchbench/scripts/run_method.sh" --help >/dev/null
bash "${REPO_ROOT}/benchmarks/claw-eval/scripts/run_baseline.sh" --help >/dev/null
bash "${REPO_ROOT}/benchmarks/claw-eval/scripts/run_method.sh" --help >/dev/null

printf '[smoke] runtime resolver\n'
bash "${REPO_ROOT}/runtime/resolve-runtime.sh" >/dev/null

printf '[smoke] python compilation\n'
python3 -m compileall -q \
  "${REPO_ROOT}/benchmarks/pinchbench/dataset/scripts" \
  "${REPO_ROOT}/benchmarks/pinchbench/dataset/tests" \
  "${REPO_ROOT}/benchmarks/claw-eval/scripts"

printf '[smoke] passed\n'
