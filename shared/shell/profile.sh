#!/usr/bin/env bash
set -euo pipefail

TOKENPILOT_PROFILE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export TOKENPILOT_PROFILE_ROOT

load_tokenpilot_profile() {
  local benchmark="${1:?benchmark is required}"
  local method="${2:?method is required}"
  local mode="${3:?session mode is required}"
  local profile_path="${TOKENPILOT_PROFILE_ROOT}/profiles/${benchmark}/${method}/${mode}.env"
  if [[ ! -f "${profile_path}" ]]; then
    printf 'Unknown TokenPilot profile: %s/%s/%s\n' "${benchmark}" "${method}" "${mode}" >&2
    return 1
  fi
  # Profiles contain defaults only; explicit shell variables remain authoritative.
  set -a
  # shellcheck disable=SC1090
  source "${profile_path}"
  set +a
  export TOKENPILOT_ACTIVE_PROFILE="${benchmark}/${method}/${mode}"
}
