#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

MODE="${1:-all}"
shift || true

usage() {
  cat <<'EOF'
usage: ./scripts/e2e.sh [all|cache|cache-multi|cache-fork|semantic|summary|compaction|report] [args...]

modes:
  all          run cache acceptance, then semantic E2E, then summary E2E, then compaction E2E, then acceptance report
  cache        run cache acceptance in all mode
  cache-multi  run cache acceptance in multi mode
  cache-fork   run cache acceptance in fork mode
  semantic     run semantic reduction E2E
  summary      run summary E2E
  compaction   run compaction E2E
  report       build a unified acceptance report from latest artifacts

examples:
  ./scripts/e2e.sh
  ./scripts/e2e.sh cache
  TARGET_CLEAN_RUNS=1 ./scripts/e2e.sh cache-fork
  EMBEDDING_PROVIDER=api ./scripts/e2e.sh semantic
  ./scripts/e2e.sh summary
  ./scripts/e2e.sh compaction
  ./scripts/e2e.sh report
EOF
}

run_cache() {
  local cache_mode="${1:-all}"
  echo "[ecoclaw e2e] cache mode=$cache_mode"
  bash "$SCRIPT_DIR/cache_acceptance.sh" "$cache_mode" "$@"
}

run_semantic() {
  echo "[ecoclaw e2e] semantic mode"
  bash "$SCRIPT_DIR/semantic_e2e.sh" "$@"
}

run_summary() {
  echo "[ecoclaw e2e] summary mode"
  bash "$SCRIPT_DIR/summary_e2e.sh" "$@"
}

run_compaction() {
  echo "[ecoclaw e2e] compaction mode"
  bash "$SCRIPT_DIR/compaction_e2e.sh" "$@"
}

run_report() {
  echo "[ecoclaw e2e] acceptance report mode"
  bash "$SCRIPT_DIR/acceptance_report.sh" "$@"
}

case "$MODE" in
  all)
    run_cache all "$@"
    run_semantic "$@"
    run_summary "$@"
    run_compaction "$@"
    run_report "$@"
    ;;
  cache)
    run_cache all "$@"
    ;;
  cache-multi)
    run_cache multi "$@"
    ;;
  cache-fork)
    run_cache fork "$@"
    ;;
  semantic)
    run_semantic "$@"
    ;;
  summary)
    run_summary "$@"
    ;;
  compaction)
    run_compaction "$@"
    ;;
  report)
    run_report "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "unknown mode: $MODE" >&2
    echo >&2
    usage >&2
    exit 2
    ;;
esac
