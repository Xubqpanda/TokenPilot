# PinchBench Experiments

This directory contains the PinchBench experiment harness for the TokenPilot runtime path.

This subtree keeps the public PinchBench benchmark surface for the current TokenPilot-based LightRSI method path and its matching single-agent baseline.

The harness consumes a local LightRSI checkout through `TOKENPILOT_RUNTIME_ROOT`. The runtime copy remains `~/.openclaw/extensions/tokenpilot` for OpenClaw compatibility.

## Current Contents

- `docs/runtime-profile.md`
  - shared runtime profile used by the PinchBench method runs
- `docs/migration-scope.md`
  - keep/defer/drop inventory for the first merge pass
- `docs/layout-plan.md`
  - target subtree structure and directory ownership rules
- `dataset/`
  - current home for:
    - `tasks/`
    - `assets/` (downloaded locally from shared external storage)
    - `scripts/`
- `scripts/`
  - current home for the official baseline/method runners and shared helpers
- `save/`
  - generated output, grouped by `baseline/tokenpilot` and
    `isolated/continuous`; this directory is ignored

## External data and result storage

Large PinchBench assets and produced result bundles are stored outside Git.

Google Drive root:

- <https://drive.google.com/drive/u/0/folders/1AeMW693aMhyBKscUDbaxnrXfvE8aSBXg>

Recommended Drive layout for this benchmark:

```text
LightRSI-Experiment/
└── TokenPilot/
    ├── experiment-data/
    │   └── pinchbench/
    │       └── assets/
    └── experiment-results/
        └── pinchbench/
            ├── isolated/
            └── continuous/
```

Local mount point for the input asset bundle:

- `benchmarks/pinchbench/dataset/assets/`

Before running a fresh machine:

1. download `assets/` from Drive
2. copy the files into `dataset/assets/`
3. run the official baseline or method command
4. upload large result folders/logs to `experiment-results/pinchbench/`

## Official runners

The recommended public runner surface is intentionally small:

- `scripts/run_baseline.sh`
- `scripts/run_method.sh`

These are the main entrypoints for reproduction.

### Baseline

Minimal isolated baseline run:

```bash
cd /path/to/TokenPilot
export TOKENPILOT_RUNTIME_ROOT=/path/to/LightRSI
bash benchmarks/pinchbench/scripts/run_baseline.sh \
  --suite automated-only \
  --session-mode isolated \
  --model gpt-5.4-mini
```

### Method

Minimal isolated method run:

```bash
cd /path/to/TokenPilot
export TOKENPILOT_RUNTIME_ROOT=/path/to/LightRSI
bash benchmarks/pinchbench/scripts/run_method.sh \
  --suite automated-only \
  --session-mode isolated \
  --model lightrsi/gpt-5.4-mini
```

Continuous method run:

```bash
cd /path/to/TokenPilot
export TOKENPILOT_RUNTIME_ROOT=/path/to/LightRSI
bash benchmarks/pinchbench/scripts/run_method.sh \
  --suite automated-only \
  --session-mode continuous \
  --model lightrsi/gpt-5.4-mini
```

## Auxiliary runners

The following scripts remain useful, but they are not the primary public API:

- `scripts/run_experiment_matrix.sh`
  - batch orchestration over multiple baseline/method cases
- `scripts/run.sh`
  - convenience wrapper that launches the default experiment matrix

## Notes

- Baseline output is written under `save/baseline/<mode>/`; TokenPilot output is written under `save/tokenpilot/<mode>/`.
- The method examples use `tokenpilot/<model>` when the benchmark is routed through the TokenPilot provider path; `lightrsi/<model>` is the canonical platform provider prefix.
- If you need broader batch orchestration, use the auxiliary `scripts/run_experiment_matrix.sh` wrapper after the main baseline and method runners work on your machine.
