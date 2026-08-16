#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINCHBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
DATASET_DIR="${PINCHBENCH_DATASET_DIR:-${PINCHBENCH_ROOT}/dataset}"
MANIFEST_PATH="${PINCHBENCH_MANIFEST_PATH:-${DATASET_DIR}/tasks/manifest.yaml}"
ESTIMATOR_ENV_FILE="${PINCHBENCH_ROOT}/.env"

if [[ -f "${ESTIMATOR_ENV_FILE}" ]]; then
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" ]] && continue
    [[ "${line}" == \#* ]] && continue
    [[ "${line}" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -n "${!key+x}" ]]; then
      continue
    fi
    export "${key}=${value}"
  done < "${ESTIMATOR_ENV_FILE}"
fi

METHOD_MODEL="${PINCHBENCH_METHOD_MODEL:-${TOKENPILOT_METHOD_MODEL:-tokenpilot/gpt-5.4-mini}}"
METHOD_JUDGE="${PINCHBENCH_METHOD_JUDGE:-${TOKENPILOT_METHOD_JUDGE:-gpt-5.4-mini}}"
METHOD_RUNS="${TOKENPILOT_RUNS:-1}"
METHOD_PARALLEL="${TOKENPILOT_PARALLEL:-1}"
METHOD_TIMEOUT="${TOKENPILOT_TIMEOUT_MULTIPLIER:-1.0}"
SESSION_MODE="${TOKENPILOT_SESSION_MODE:-continuous}"

OUTPUT_ROOT="${PINCHBENCH_CATEGORY_OUTPUT_ROOT:-${PINCHBENCH_ROOT}/save/by_category/method}"
RUN_TAG="${PINCHBENCH_CATEGORY_RUN_TAG:-$(date +%Y%m%d_%H%M%S)}"
CATEGORY_FILTER="${PINCHBENCH_CATEGORY_FILTER:-}"
TASK_FILTER="${PINCHBENCH_TASK_FILTER:-}"
TOP_K="${TOKENPILOT_MEMORY_TOP_K:-0}"
SOURCE_OPENCLAW_HOME="${PINCHBENCH_SOURCE_OPENCLAW_HOME:-${HOME}}"
SOURCE_OPENCLAW_CFG="${PINCHBENCH_SOURCE_OPENCLAW_CFG:-${SOURCE_OPENCLAW_HOME}/.openclaw/openclaw.json}"
TMP_ROOT_BASE="${PINCHBENCH_CATEGORY_TMP_ROOT_BASE:-/tmp/pinchbench_by_category}"
BASE_GATEWAY_PORT="${PINCHBENCH_CATEGORY_BASE_GATEWAY_PORT:-19889}"
BASE_PROXY_PORT="${PINCHBENCH_CATEGORY_BASE_PROXY_PORT:-18688}"
PINCHBENCH_FWS_SHARED_DATA_DIR="${PINCHBENCH_FWS_SHARED_DATA_DIR:-${HOME}/.local/share/fws}"
PINCHBENCH_GWS_SHARED_CONFIG_DIR="${PINCHBENCH_GWS_SHARED_CONFIG_DIR:-${HOME}/.local/share/fws/config}"

if [[ "${SESSION_MODE}" != "continuous" ]]; then
  echo "run_method_by_category_continuous.sh requires TOKENPILOT_SESSION_MODE=continuous (current=${SESSION_MODE})" >&2
  exit 1
fi

if [[ ! -f "${MANIFEST_PATH}" ]]; then
  echo "Missing manifest: ${MANIFEST_PATH}" >&2
  exit 1
fi

echo "[by-category] manifest=${MANIFEST_PATH}"
echo "[by-category] model=${METHOD_MODEL}"
echo "[by-category] judge=${METHOD_JUDGE}"
echo "[by-category] session_mode=${SESSION_MODE}"
echo "[by-category] top_k=${TOP_K}"
echo "[by-category] output_root=${OUTPUT_ROOT}"
echo "[by-category] source_openclaw_home=${SOURCE_OPENCLAW_HOME}"
echo "[by-category] tmp_root_base=${TMP_ROOT_BASE}"
echo "[by-category] fws_shared_data_dir=${PINCHBENCH_FWS_SHARED_DATA_DIR}"
echo "[by-category] gws_shared_config_dir=${PINCHBENCH_GWS_SHARED_CONFIG_DIR}"
if [[ -n "${CATEGORY_FILTER}" ]]; then
  echo "[by-category] category_filter=${CATEGORY_FILTER}"
fi
if [[ -n "${TASK_FILTER}" ]]; then
  echo "[by-category] task_filter=${TASK_FILTER}"
fi

mapfile -t CATEGORY_ROWS < <(
  python3 - "${MANIFEST_PATH}" "${CATEGORY_FILTER}" "${TASK_FILTER}" <<'PY'
import sys
from pathlib import Path
import yaml

manifest_path = Path(sys.argv[1])
category_filter_raw = sys.argv[2].strip()
task_filter_raw = sys.argv[3].strip()
allowed = {item.strip() for item in category_filter_raw.split(",") if item.strip()}
task_allowed = {item.strip() for item in task_filter_raw.split(",") if item.strip()}

data = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
categories = data.get("categories", {}) or {}

for category, task_ids in categories.items():
    if allowed and category not in allowed:
        continue
    items = [str(task_id).strip() for task_id in (task_ids or []) if str(task_id).strip()]
    if task_allowed:
        items = [task_id for task_id in items if task_id in task_allowed]
    if not items:
        continue
    print(f"{category}\t{','.join(items)}")
PY
)

if [[ "${#CATEGORY_ROWS[@]}" -eq 0 ]]; then
  echo "No categories selected from manifest." >&2
  exit 1
fi

mkdir -p "${OUTPUT_ROOT}"

setup_category_runtime() {
  local category="$1"
  local index="$2"
  local category_slug
  category_slug="$(printf '%s' "${category}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-')"
  local run_tag_compact
  local profile_suffix
  run_tag_compact="$(printf '%s' "${RUN_TAG}" | tr -cd 'a-zA-Z0-9' | tail -c 13)"
  profile_suffix="$(printf '%s' "${category_slug}" | tr -cd 'a-zA-Z0-9' | head -c 12)"
  if [[ -z "${profile_suffix}" ]]; then
    profile_suffix="cat${index}"
  fi

  CATEGORY_TMP_ROOT="${TMP_ROOT_BASE}/${RUN_TAG}/${category_slug}"
  CATEGORY_OPENCLAW_HOME="${CATEGORY_TMP_ROOT}/openclaw_home"
  CATEGORY_OPENCLAW_CFG="${CATEGORY_OPENCLAW_HOME}/.openclaw/openclaw.json"
  CATEGORY_OPENCLAW_STATE_DIR="${CATEGORY_OPENCLAW_HOME}/.openclaw"
  CATEGORY_OPENCLAW_PROFILE="pbc_${run_tag_compact}_${profile_suffix}"
  CATEGORY_GATEWAY_PORT="$((BASE_GATEWAY_PORT + index))"
  CATEGORY_PROXY_PORT="$((BASE_PROXY_PORT + index))"
  CATEGORY_FWS_DATA_DIR="${CATEGORY_TMP_ROOT}/fws-shared"
  CATEGORY_GWS_SOURCE_CONFIG_DIR="${CATEGORY_TMP_ROOT}/gws-shared-config"

  echo "[by-category] runtime_tmp_root=${CATEGORY_TMP_ROOT}"
  echo "[by-category] runtime_openclaw_home=${CATEGORY_OPENCLAW_HOME}"
  echo "[by-category] runtime_gateway_port=${CATEGORY_GATEWAY_PORT}"
  echo "[by-category] runtime_proxy_port=${CATEGORY_PROXY_PORT}"

  if [[ -d "${CATEGORY_TMP_ROOT}" ]]; then
    OPENCLAW_CONFIG_PATH="${CATEGORY_OPENCLAW_CFG}" \
    OPENCLAW_STATE_DIR="${CATEGORY_OPENCLAW_STATE_DIR}" \
    OPENCLAW_PROFILE="${CATEGORY_OPENCLAW_PROFILE}" \
    OPENCLAW_GATEWAY_PORT="${CATEGORY_GATEWAY_PORT}" \
    openclaw --profile "${CATEGORY_OPENCLAW_PROFILE}" gateway stop >/dev/null 2>&1 || true
    rm -rf "${CATEGORY_TMP_ROOT}"
  fi

  mkdir -p "${CATEGORY_OPENCLAW_HOME}"
  mkdir -p "${CATEGORY_FWS_DATA_DIR}"
  mkdir -p "${CATEGORY_GWS_SOURCE_CONFIG_DIR}"

  if [[ -d "${PINCHBENCH_FWS_SHARED_DATA_DIR}" ]]; then
    cp -a "${PINCHBENCH_FWS_SHARED_DATA_DIR}/." "${CATEGORY_FWS_DATA_DIR}/"
  fi
  if [[ -d "${PINCHBENCH_GWS_SHARED_CONFIG_DIR}" ]]; then
    cp -a "${PINCHBENCH_GWS_SHARED_CONFIG_DIR}/." "${CATEGORY_GWS_SOURCE_CONFIG_DIR}/"
  fi

  CATEGORY_FWS_ENV_FILE="${CATEGORY_TMP_ROOT}/fws.env"
  if [[ "${category}" == "skills" || "${category}" == "meeting_analysis" || "${category}" == "integrations" || "${category}" == "research" || "${category}" == "github" || "${category}" == "gws" ]]; then
    if command -v fws >/dev/null 2>&1; then
      (
        export FWS_DATA_DIR="${CATEGORY_FWS_DATA_DIR}"
        fws server stop >/dev/null 2>&1 || true
        fws server start > "${CATEGORY_FWS_ENV_FILE}" 2>/dev/null || true
      )
    fi
  fi

  if [[ -f "${CATEGORY_FWS_ENV_FILE}" ]]; then
    while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
      line="${raw_line#export }"
      [[ "${line}" == *=* ]] || continue
      key="${line%%=*}"
      value="${line#*=}"
      value="${value%\"}"
      value="${value#\"}"
      value="${value%\'}"
      value="${value#\'}"
      case "${key}" in
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR|GOOGLE_WORKSPACE_CLI_TOKEN|HTTPS_PROXY|SSL_CERT_FILE|GH_TOKEN|GH_REPO)
          export "${key}=${value}"
          ;;
      esac
    done < "${CATEGORY_FWS_ENV_FILE}"
  fi

  if [[ ! -d "${SOURCE_OPENCLAW_HOME}/.openclaw" ]]; then
    echo "Missing source OpenClaw state dir: ${SOURCE_OPENCLAW_HOME}/.openclaw" >&2
    exit 1
  fi
  cp -a "${SOURCE_OPENCLAW_HOME}/.openclaw" "${CATEGORY_OPENCLAW_HOME}/.openclaw"

  rm -rf "${CATEGORY_OPENCLAW_STATE_DIR}/agents"
  mkdir -p "${CATEGORY_OPENCLAW_STATE_DIR}/agents"
  rm -rf \
    "${CATEGORY_OPENCLAW_STATE_DIR}/extensions/tokenpilot" \
    "${CATEGORY_OPENCLAW_STATE_DIR}/tokenpilot-plugin-state"

  python3 - "${CATEGORY_OPENCLAW_CFG}" "${METHOD_MODEL}" <<'PY'
import json
import sys

config_path = sys.argv[1]
method_model = sys.argv[2]

with open(config_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

agents = data.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
model_cfg = defaults.setdefault("model", {})
models_cfg = defaults.setdefault("models", {})
model_cfg["primary"] = method_model
model_cfg["fallbacks"] = []
if method_model not in models_cfg:
    models_cfg[method_model] = {}

plugins = data.setdefault("plugins", {})
plugins["allow"] = ["tokenpilot"]

entries = plugins.get("entries")
if isinstance(entries, dict):
    entries.pop("tokenpilot", None)
    if not entries:
        plugins.pop("entries", None)

installs = plugins.get("installs")
if isinstance(installs, dict):
    installs.pop("tokenpilot", None)
    if not installs:
        plugins.pop("installs", None)

load_cfg = plugins.get("load")
if isinstance(load_cfg, dict):
    paths = load_cfg.get("paths")
    if isinstance(paths, list):
        filtered = []
        for item in paths:
            if not isinstance(item, str):
                continue
            lowered = item.lower()
            if "/extensions/tokenpilot" in lowered:
                continue
            filtered.append(item)
        if filtered:
            load_cfg["paths"] = filtered
        else:
            plugins.pop("load", None)

with open(config_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

  (
    cd "${REPO_ROOT}"
    TOKENPILOT_OPENCLAW_HOME="${CATEGORY_OPENCLAW_HOME}" \
    OPENCLAW_CONFIG_PATH="${CATEGORY_OPENCLAW_CFG}" \
    OPENCLAW_STATE_DIR="${CATEGORY_OPENCLAW_STATE_DIR}" \
    OPENCLAW_PROFILE="${CATEGORY_OPENCLAW_PROFILE}" \
    OPENCLAW_GATEWAY_PORT="${CATEGORY_GATEWAY_PORT}" \
    TOKENPILOT_PROXY_PORT="${CATEGORY_PROXY_PORT}" \
    FWS_DATA_DIR="${CATEGORY_FWS_DATA_DIR}" \
    GWS_SOURCE_CONFIG_DIR="${CATEGORY_GWS_SOURCE_CONFIG_DIR}" \
    install_tokenpilot_runtime
  )
}

for i in "${!CATEGORY_ROWS[@]}"; do
  row="${CATEGORY_ROWS[$i]}"
  category="${row%%$'\t'*}"
  suite="${row#*$'\t'}"
  category_output_dir="${OUTPUT_ROOT}/${RUN_TAG}/${category}"

  echo
  echo "================================================================================"
  echo "[by-category] category=${category}"
  echo "[by-category] suite=${suite}"
  echo "[by-category] category_output_dir=${category_output_dir}"
  echo "================================================================================"

  setup_category_runtime "${category}" "$((i + 1))"

  PINCHBENCH_MEETING_OUTPUT_DIR="${category_output_dir}" \
  PINCHBENCH_TMP_ROOT="${CATEGORY_TMP_ROOT}" \
  TOKENPILOT_OPENCLAW_HOME="${CATEGORY_OPENCLAW_HOME}" \
  OPENCLAW_CONFIG_PATH="${CATEGORY_OPENCLAW_CFG}" \
  OPENCLAW_STATE_DIR="${CATEGORY_OPENCLAW_STATE_DIR}" \
  OPENCLAW_PROFILE="${CATEGORY_OPENCLAW_PROFILE}" \
  OPENCLAW_GATEWAY_PORT="${CATEGORY_GATEWAY_PORT}" \
  TOKENPILOT_GATEWAY_PORT="${CATEGORY_GATEWAY_PORT}" \
  TOKENPILOT_PROXY_PORT="${CATEGORY_PROXY_PORT}" \
  FWS_DATA_DIR="${CATEGORY_FWS_DATA_DIR}" \
  GWS_SOURCE_CONFIG_DIR="${CATEGORY_GWS_SOURCE_CONFIG_DIR}" \
  GOOGLE_WORKSPACE_CLI_CONFIG_DIR="${GOOGLE_WORKSPACE_CLI_CONFIG_DIR:-}" \
  GOOGLE_WORKSPACE_CLI_TOKEN="${GOOGLE_WORKSPACE_CLI_TOKEN:-}" \
  HTTPS_PROXY="${HTTPS_PROXY:-}" \
  SSL_CERT_FILE="${SSL_CERT_FILE:-}" \
  GH_TOKEN="${GH_TOKEN:-}" \
  GH_REPO="${GH_REPO:-}" \
  TOKENPILOT_SESSION_MODE="${SESSION_MODE}" \
  "${SCRIPT_DIR}/run_method.sh" \
    --model "${METHOD_MODEL}" \
    --judge "${METHOD_JUDGE}" \
    --suite "${suite}" \
    --runs "${METHOD_RUNS}" \
    --parallel "${METHOD_PARALLEL}" \
    --timeout-multiplier "${METHOD_TIMEOUT}" \
    --session-mode "${SESSION_MODE}" \
    --output-dir "${category_output_dir}"
done

echo
echo "[by-category] completed run_tag=${RUN_TAG}"
echo "[by-category] results_root=${OUTPUT_ROOT}/${RUN_TAG}"
