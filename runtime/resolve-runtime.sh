#!/usr/bin/env bash
set -euo pipefail

TOKENPILOT_EXPERIMENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TOKENPILOT_EXPERIMENT_ROOT

resolve_tokenpilot_runtime_root() {
  local candidate="${TOKENPILOT_RUNTIME_ROOT:-${LIGHTRSI_ROOT:-}}"
  if [[ -z "${candidate}" ]]; then
    printf 'Missing TOKENPILOT_RUNTIME_ROOT. Point it to a local LightRSI checkout.\n' >&2
    return 1
  fi
  candidate="$(cd "${candidate}" 2>/dev/null && pwd)" || {
    printf 'TokenPilot runtime checkout does not exist: %s\n' "${candidate}" >&2
    return 1
  }
  if [[ ! -f "${candidate}/package.json" || ! -f "${candidate}/pnpm-lock.yaml" ]]; then
    printf 'TokenPilot runtime root is not a LightRSI checkout: %s\n' "${candidate}" >&2
    return 1
  fi
  TOKENPILOT_RUNTIME_ROOT="${candidate}"
  export TOKENPILOT_RUNTIME_ROOT
  printf '%s\n' "${TOKENPILOT_RUNTIME_ROOT}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  resolve_tokenpilot_runtime_root
fi
