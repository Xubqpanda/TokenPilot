#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW_EVAL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${CLAW_EVAL_ROOT}/../.." && pwd)"

if [[ -f "${CLAW_EVAL_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${CLAW_EVAL_ROOT}/.env"
  set +a
elif [[ -f "${CLAW_EVAL_ROOT}/../pinchbench/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${CLAW_EVAL_ROOT}/../pinchbench/.env"
  set +a
fi

CATEGORY="${CLAW_EVAL_CATEGORY:-synthesis}"
MODEL="${CLAW_EVAL_MODEL:-tokenpilot/gpt-5.4-mini}"
OPENCLAW_HOME="${TOKENPILOT_OPENCLAW_HOME:-/home/xubuqiang}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_HOME}/.openclaw/openclaw.json}"
PLUGIN_DIR="${OPENCLAW_HOME}/.openclaw/extensions/tokenpilot"
LEGACY_PLUGIN_DIR="${OPENCLAW_HOME}/.openclaw/extensions/ecoclaw"

export TOKENPILOT_OPENCLAW_HOME="${OPENCLAW_HOME}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG}"

echo "[1/2] install plugin"
rm -rf "${PLUGIN_DIR}" "${LEGACY_PLUGIN_DIR}"
cd "${PROJECT_ROOT}"
pnpm plugin:install:release

echo "[2/2] run claw-eval category smoke"
CLAW_EVAL_CATEGORY="${CATEGORY}" \
CLAW_EVAL_MODEL="${MODEL}" \
bash "${SCRIPT_DIR}/run_claw_eval_continuous_category_plugin_tmpconfig.sh" --foreground
