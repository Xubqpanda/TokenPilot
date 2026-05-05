#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${EXPERIMENT_ROOT}/../.." && pwd)"

CATEGORY="${CLAW_EVAL_CATEGORY:-synthesis}"
SESSION_MODE="${CLAW_EVAL_SESSION_MODE:-continuous}"
# Default to a direct upstream provider so this smoke bypasses tokenpilot/plugin routing.
MODEL="${CLAW_EVAL_MODEL:-kuaipao/gpt-5.4-mini}"
JUDGE="${CLAW_EVAL_JUDGE_MODEL:-${MODEL}}"
MAX_TASKS="${CLAW_EVAL_MAX_TASKS:-0}"

exec bash "${EXPERIMENT_ROOT}/scripts/run_baseline.sh" \
  --session-mode "${SESSION_MODE}" \
  --scope category \
  --category "${CATEGORY}" \
  --model "${MODEL}" \
  --judge "${JUDGE}" \
  --max-tasks "${MAX_TASKS}" \
  --tmp-openclaw
