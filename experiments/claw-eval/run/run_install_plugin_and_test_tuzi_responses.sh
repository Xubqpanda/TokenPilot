#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${EXPERIMENT_ROOT}/../.." && pwd)"

OPENCLAW_HOME="${TOKENPILOT_OPENCLAW_HOME:-/home/xubuqiang}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_HOME}/.openclaw/openclaw.json}"
CLI_CATEGORY="${1:-}"
CATEGORY="${CLI_CATEGORY:-${CLAW_EVAL_CATEGORY:-productivity}}"
MODEL="${CLAW_EVAL_MODEL:-tokenpilot/gpt-5.4-mini}"
TUZI_BASE_URL="${TUZI_BASE_URL:-https://coding.tu-zi.com/v1}"
TUZI_API_KEY="${TUZI_API_KEY:-sk-d74d886418631f9c330806a007ae5e3449f554075afe3e311b4980611abea157}"

echo "[0/3] ensure tuzi upstream provider in ${OPENCLAW_CONFIG_PATH}"
python - <<'PY' "${OPENCLAW_CONFIG_PATH}" "${TUZI_BASE_URL}" "${TUZI_API_KEY}"
import json, pathlib, sys
cfg_path = pathlib.Path(sys.argv[1])
base_url = sys.argv[2]
api_key = sys.argv[3]
doc = json.loads(cfg_path.read_text())
doc.setdefault("models", {}).setdefault("providers", {})
providers = doc["models"]["providers"]
providers["tuzi"] = {
    "baseUrl": base_url,
    "apiKey": api_key,
    "api": "openai-responses",
    "models": [
        {
            "id": "gpt-5.4-mini",
            "name": "gpt-5.4-mini",
            "reasoning": True,
            "input": ["text", "image"],
            "contextWindow": 128000,
            "maxTokens": 8192,
        },
        {
            "id": "gpt-5.4",
            "name": "gpt-5.4",
            "reasoning": True,
            "input": ["text", "image"],
            "contextWindow": 128000,
            "maxTokens": 8192,
        },
    ],
}
cfg_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2))
print("updated", cfg_path)
PY

echo "[1/3] install plugin"
rm -rf "${OPENCLAW_HOME}/.openclaw/extensions/tokenpilot" "${OPENCLAW_HOME}/.openclaw/extensions/ecoclaw" || true

cd "${PROJECT_ROOT}"
TOKENPILOT_OPENCLAW_HOME="${OPENCLAW_HOME}" \
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}" \
pnpm plugin:install:release

echo "[2/3] run claw-eval plugin smoke via tuzi responses upstream"
echo "category=${CATEGORY}"
echo "model=${MODEL}"
CLAW_EVAL_CATEGORY="${CATEGORY}" \
CLAW_EVAL_MODEL="${MODEL}" \
TOKENPILOT_EVICTION_REPLACEMENT_MODE="${TOKENPILOT_EVICTION_REPLACEMENT_MODE:-drop}" \
bash "${EXPERIMENT_ROOT}/run/run_claw_eval_continuous_category_plugin_tmpconfig.sh" --foreground
