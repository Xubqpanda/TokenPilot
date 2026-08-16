#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

GWS_VERSION="${GWS_VERSION:-0.22.5}"
FWS_PACKAGE="${FWS_PACKAGE:-@juppytt/fws}"
INSTALL_BIN_DIR="${INSTALL_BIN_DIR:-${HOME}/.local/bin}"
TMP_DIR="${TMP_DIR:-/tmp/pinchbench_gws_fws_setup}"
GWS_TARGET="${GWS_TARGET:-}"

mkdir -p "${INSTALL_BIN_DIR}" "${TMP_DIR}"

echo "[setup] install bin dir: ${INSTALL_BIN_DIR}"
echo "[setup] temp dir: ${TMP_DIR}"

gws_works() {
  if ! command -v gws >/dev/null 2>&1; then
    return 1
  fi
  if gws --help >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

pick_gws_target() {
  if [[ -n "${GWS_TARGET}" ]]; then
    printf '%s\n' "${GWS_TARGET}"
    return
  fi

  local glibc_version
  glibc_version="$(ldd --version 2>/dev/null | head -n 1 | grep -oE '[0-9]+\.[0-9]+$' || true)"
  if [[ -z "${glibc_version}" ]]; then
    printf '%s\n' "x86_64-unknown-linux-musl"
    return
  fi

  python3 - "${glibc_version}" <<'PY'
import sys
parts = tuple(int(x) for x in sys.argv[1].split('.'))
print('x86_64-unknown-linux-musl' if parts < (2, 39) else 'x86_64-unknown-linux-gnu')
PY
}

install_gws() {
  if gws_works; then
    echo "[setup] gws already present and working: $(command -v gws)"
    return
  fi

  if command -v gws >/dev/null 2>&1; then
    echo "[setup] existing gws is broken, replacing: $(command -v gws)"
  fi

  local target
  target="$(pick_gws_target)"

  local base_url="https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}"
  local tar_name="google-workspace-cli-${target}.tar.gz"
  local tar_path="${TMP_DIR}/${tar_name}"
  local sha_path="${TMP_DIR}/${tar_name}.sha256"
  local unpack_dir="${TMP_DIR}/gws-unpack"

  echo "[setup] downloading gws ${GWS_VERSION} target=${target}"
  curl -L --retry 8 --retry-delay 2 -o "${tar_path}" "${base_url}/${tar_name}"

  echo "[setup] downloading gws checksum"
  curl -L --retry 12 --retry-delay 3 -o "${sha_path}" "${base_url}/${tar_name}.sha256"

  echo "[setup] verifying checksum"
  (
    cd "${TMP_DIR}"
    sha256sum -c "$(basename "${sha_path}")"
  )

  rm -rf "${unpack_dir}"
  mkdir -p "${unpack_dir}"
  tar -xzf "${tar_path}" -C "${unpack_dir}"

  local gws_bin
  gws_bin="$(find "${unpack_dir}" -type f -name gws | head -n 1)"
  if [[ -z "${gws_bin}" ]]; then
    echo "[setup] failed to locate gws binary after unpack" >&2
    exit 1
  fi

  rm -f "${INSTALL_BIN_DIR}/gws"
  install -m 0755 "${gws_bin}" "${INSTALL_BIN_DIR}/gws"
  echo "[setup] installed gws to ${INSTALL_BIN_DIR}/gws"
}

install_fws() {
  if command -v fws >/dev/null 2>&1; then
    echo "[setup] fws already present: $(command -v fws)"
    return
  fi

  echo "[setup] installing fws package ${FWS_PACKAGE}"
  npm install -g "${FWS_PACKAGE}"
}

ensure_path_hint() {
  case ":${PATH}:" in
    *":${INSTALL_BIN_DIR}:"*) ;;
    *)
      echo
      echo "[setup] ${INSTALL_BIN_DIR} is not currently in PATH."
      echo "[setup] add this before running PinchBench:"
      echo "export PATH=\"${INSTALL_BIN_DIR}:\$PATH\""
      ;;
  esac
}

print_verify() {
  echo
  echo "[setup] verification"
  echo "gws => $(command -v gws || echo MISSING)"
  echo "fws => $(command -v fws || echo MISSING)"
  if command -v gws >/dev/null 2>&1; then
    gws --help >/dev/null && echo "[setup] gws --help OK"
  fi
  if command -v fws >/dev/null 2>&1; then
    fws --help >/dev/null && echo "[setup] fws --help OK"
  fi
  echo
  echo "[setup] next checks"
  echo "eval \"\$(fws server start)\""
  echo "gws --help"
  echo
  echo "[setup] shared allowlist for gws/fws is already patched in:"
  echo "${ROOT_DIR}/scripts/common.sh"
}

install_gws
install_fws
ensure_path_hint
print_verify
