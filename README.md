# EcoClaw

EcoClaw is a runtime optimization layer for OpenClaw agents with one goal:
improve token efficiency while keeping task quality stable.

## What This Version Adds

- Embedded `openai-responses` proxy provider (`ecoclaw/*` explicit model keys)
- Response root-link strategy for cache reuse (`previous_response_id` injection)
- Policy-owned summary / compaction triggers with execution-side handoff artifacts
- Runtime decision dashboard (replaces the old cache-tree-only view)
- Expanded `/ecoclaw` command set (`help/status/cache/session` controls)
- Full event tracing for Context / Decision / Execution / Orchestration analysis

## High-Level Framework

EcoClaw is organized as semantic layers:

- `packages/kernel`: runtime context, pipeline contracts, event bus
- `packages/layers/context`: context-state, retrieval, and future session-view builders
- `packages/layers/decision`: policy, task-router, decision-ledger
- `packages/layers/execution`: stabilizer, compaction, summary, reduction
- `packages/layers/orchestration`: OpenClaw connector and session topology
- `packages/providers/*`: provider-specific usage normalization and prompt annotation
- `packages/storage/fs`: filesystem persistence for traces, turns, branches, and messages
- `packages/openclaw-plugin`: deployable OpenClaw plugin entry
- `apps/lab-bench`: benchmark harness and runtime dashboard

Detailed architecture: [docs/architecture.md](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/docs/architecture.md)

## Quick Start

Recommended release-mode install:

```bash
cd packages/openclaw-plugin
npm run install:release
```

This flow:

- builds a self-contained plugin archive
- removes any conflicting dev `plugins.load.paths` entry
- installs the archive into `~/.openclaw/extensions/ecoclaw`
- restarts the gateway

If you are actively developing the plugin, use dev-mode instead and do not keep
release-mode enabled at the same time. OpenClaw will treat both as the same
plugin id and report duplicate-source conflicts.

1. Install dependencies and build:

```bash
npm install
npm run build
```

2. Development-mode install into OpenClaw:

```bash
cd packages/openclaw-plugin
npm run build
openclaw config set plugins.load.paths "[\"/abs/path/to/EcoClaw/packages/openclaw-plugin\"]"
openclaw config set plugins.allow "[\"ecoclaw\"]"
openclaw config set plugins.entries.ecoclaw.enabled true
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
corepack pnpm --filter @ecoclaw/lab-bench dev
# open http://127.0.0.1:7777
```

The dashboard focuses on:

- Per-turn token usage (input/output/cacheRead/net)
- Layer signals and module execution traces
- Compaction ROI windows (pre/post turn comparison)
- Initial vs final context segment inspection
- Stable-prefix / tail visualization for cache-oriented observation

Useful overrides:

```bash
ECOCLAW_LAB_PORT=7781 \
ECOCLAW_STATE_ROOTS="$HOME/.openclaw/ecoclaw-plugin-state/ecoclaw:/tmp/ecoclaw-lab-state/ecoclaw" \
corepack pnpm --filter @ecoclaw/lab-bench dev
```

Current scope of the dashboard:

- observation only
- reads trace + provider tap files from local state roots
- does not yet write policy overrides or mutate runtime context

## Current Scope

The current production path is intentionally narrow:

- Active provider adapters: `openai`, `anthropic`
- Active plugin runtime path: `packages/openclaw-plugin`
- Active persistence path: `packages/storage/fs`

Some higher-level modules such as `retrieval` and `task-router` are kept as
clean layer boundaries, but they are not yet deeply wired into the production
OpenClaw plugin path.

## Benchmarking

PinchBench examples:

```bash
# baseline
./experiments/scripts/run_pinchbench_baseline.sh --model gmn/gpt-5.4 --suite all --runs 1 --parallel 1

# with EcoClaw proxy provider
./experiments/scripts/run_pinchbench_baseline.sh --model ecoclaw/gpt-5.4 --suite all --runs 1 --parallel 1
```

## Summary Prompt Overrides

For `lab-bench` and other direct runtime hosts, `module-summary` now supports:

- `summaryPrompt`: inline override
- `summaryPromptPath`: prompt file path override
- `resumePrefixPrompt`: inline override
- `resumePrefixPromptPath`: prompt file path override

`lab-bench` exposes these via environment variables:

```bash
ECOCLAW_SUMMARY_PROMPT_PATH=/abs/path/summary-prompt.txt
ECOCLAW_RESUME_PREFIX_PROMPT_PATH=/abs/path/resume-prefix.txt
```

Or inline:

```bash
ECOCLAW_SUMMARY_PROMPT="Write a compact handoff with explicit pending steps."
ECOCLAW_RESUME_PREFIX_PROMPT="Use this prior summary as the starting point:"
```
