# EcoClaw

EcoClaw is a runtime optimization layer for OpenClaw agents with one goal:
improve token efficiency while keeping task quality stable.

## What This Version Adds

- Embedded `openai-responses` proxy provider (`ecoclaw/*` explicit model keys)
- Response root-link strategy for cache reuse (`previous_response_id` injection)
- Static compaction trigger module in execution layer
- Runtime decision dashboard (replaces the old cache-tree-only view)
- Expanded `/ecoclaw` command set (`help/status/cache/session` controls)
- Full event tracing for Data / Decision / Execution / Orchestration analysis

## High-Level Framework

EcoClaw is organized as semantic layers:

- `packages/kernel`: runtime context, pipeline contracts, event bus
- `packages/layers/data`: memory-state and retrieval
- `packages/layers/decision`: policy, task-router, decision-ledger
- `packages/layers/execution`: cache, compaction-trigger, summary, compression
- `packages/layers/orchestration`: OpenClaw connector and session topology
- `packages/openclaw-plugin`: deployable OpenClaw plugin entry
- `apps/lab-bench`: benchmark harness and runtime dashboard

Detailed architecture: [docs/architecture.md](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/docs/architecture.md)

## Quick Start

1. Install dependencies and build:

```bash
npm install
npm run build
```

2. Install plugin into OpenClaw:

```bash
cd packages/openclaw-plugin
npm run build
openclaw plugins install .
openclaw gateway restart
```

3. Use explicit EcoClaw provider model in OpenClaw:

```text
ecoclaw/gpt-5.4
```

Plugin usage and command guide: [packages/openclaw-plugin/README.md](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/README.md)

## Runtime Dashboard

```bash
cd apps/lab-bench
ECOCLAW_STATE_DIR=/tmp/ecoclaw-plugin-state npm run web:cachetree
# open http://127.0.0.1:7777
```

The dashboard focuses on:

- Per-turn token usage (input/output/cacheRead/net)
- Layer signals and module execution traces
- Compaction ROI windows (pre/post turn comparison)

## Benchmarking

PinchBench examples:

```bash
# baseline
./experiments/scripts/run_pinchbench_baseline.sh --model gmn/gpt-5.4 --suite all --runs 1 --parallel 1

# with EcoClaw proxy provider
./experiments/scripts/run_pinchbench_baseline.sh --model ecoclaw/gpt-5.4 --suite all --runs 1 --parallel 1
```
