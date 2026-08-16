#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-$PWD/fws-discovery-cache}"
ARCHIVE_PATH="${2:-$PWD/fws-discovery-cache.tar.gz}"
BASE_URL="https://www.googleapis.com/discovery/v1/apis"

mkdir -p "${OUT_DIR}"

download_one() {
  local api="$1"
  local version="$2"
  local file="$3"
  local url="${BASE_URL}/${api}/${version}/rest"

  echo "[download] ${file} <= ${url}"
  curl -L --fail --retry 5 --retry-delay 2 -o "${OUT_DIR}/${file}" "${url}"
}

download_one gmail v1 gmail_v1.json
download_one calendar v3 calendar_v3.json
download_one drive v3 drive_v3.json
download_one tasks v1 tasks_v1.json
download_one sheets v4 sheets_v4.json
download_one people v1 people_v1.json

echo "[verify] downloaded files:"
ls -1 "${OUT_DIR}"

tar -czf "${ARCHIVE_PATH}" -C "${OUT_DIR}" .
echo "[done] archive => ${ARCHIVE_PATH}"
echo "[next] copy the archive to target machine and extract into one of:"
echo "       ~/.local/share/fws/discovery-cache/"
echo "       ~/.config/gws/cache/"
