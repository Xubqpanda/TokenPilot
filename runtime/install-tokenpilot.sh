#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-runtime.sh
source "${SCRIPT_DIR}/resolve-runtime.sh"

RUNTIME_ROOT="$(resolve_tokenpilot_runtime_root)"
if ! command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm is required to install the local LightMem2 runtime.\n' >&2
  exit 1
fi

if ! node -e 'const p=require(process.argv[1]); process.exit(p.scripts && p.scripts["plugin:install:release"] ? 0 : 1)' "${RUNTIME_ROOT}/package.json"; then
  printf 'LightMem2 checkout has no plugin:install:release script: %s\n' "${RUNTIME_ROOT}" >&2
  exit 1
fi

printf '[tokenpilot-runtime] root=%s\n' "${RUNTIME_ROOT}"
(
  cd "${RUNTIME_ROOT}"
  pnpm plugin:install:release
)
