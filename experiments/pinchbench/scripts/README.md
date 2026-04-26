# PinchBench Experiment Scripts

This directory contains the active experiment-side wrappers for the PinchBench
method path inside the main repository.

## Active Surface

- `run_method.sh`
  - single-agent method entrypoint
  - supports `isolated` and `continuous`
- `common.sh`
  - shared runtime/config helpers for the active method path
- `calculate_llm_cost.py`
  - post-run cost report helper

## Runtime Environment

The active method path expects runtime credentials/config to come from:

1. `experiments/pinchbench/.env`
2. repo-root `.env`
3. explicit shell exports

Required variables are:

- `ECOCLAW_BASE_URL`
- `ECOCLAW_API_KEY`

If you want to use unprefixed model aliases such as `gpt-5.4-mini`, also set:

- `PINCHBENCH_MODEL_PROVIDER_PREFIX`

The migrated mainline resolves the dataset directory in this order:

1. `PINCHBENCH_DATASET_DIR`
2. `experiments/pinchbench/dataset` in the current repository
3. legacy `ECOCLAW_SKILL_DIR` fallback

Do not point the active method path back to the external bench repository unless
you are explicitly debugging legacy behavior.

If your model strings are already fully qualified (for example
`provider/model-name`), no provider prefix variable is required.

## Deferred Surface

The following are intentionally not part of the first active consolidation pass:

- baseline wrappers
- multi-agent / MAS wrappers
- agentswing wrappers
- historical ablation launchers
- compare scripts that assume baseline is already canonicalized here

## Current Rule

For now, this directory should stay focused on the plugin-enabled method path
only. Broader experiment surfaces should be migrated only after the active
PinchBench path is cleaned and revalidated inside the main repository.
