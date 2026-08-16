# TokenPilot Experiments

Benchmark tasks, runners, and analysis for TokenPilot, a cache-efficient context management system for long-running LLM agents.

This repository contains experiment code only. The runtime and plugin source remain in [LightMem2](https://github.com/zjunlp/LightMem2).

## Layout

```text
benchmarks/
├── pinchbench/       # PinchBench tasks, runners, graders, and analysis
└── claw-eval/        # Claw-Eval tasks, runners, vendored services, plugins
profiles/
├── pinchbench/
└── claw-eval/        # baseline/TokenPilot x isolated/continuous defaults
runtime/              # local LightMem2 development-runtime bridge
```

Each benchmark has the same two method families and two session modes:

| Method | Meaning |
| :-- | :-- |
| `baseline` | OpenClaw without the TokenPilot runtime features |
| `tokenpilot` | OpenClaw with the TokenPilot runtime/plugin enabled |

| Session mode | Meaning |
| :-- | :-- |
| `isolated` | Each task starts from a fresh session |
| `continuous` | Tasks run through a shared continuing session |

## Development Setup

The current development workflow uses a local LightMem2 checkout rather than an npm package. Set the runtime explicitly:

```bash
export TOKENPILOT_RUNTIME_ROOT=/path/to/LightMem2
```

The runtime bridge installs the plugin with the checked-out LightMem2 release installer and records the selected runtime path in the command output. The experiment repository never copies or vendors the LightMem2 plugin source.

Required model configuration is supplied through environment variables or a local, ignored `.env` file. Use the templates under `profiles/` as the starting point; never commit API keys.

## Official Entrypoints

PinchBench:

```bash
bash benchmarks/pinchbench/scripts/run_baseline.sh \
  --session-mode isolated --suite automated-only

bash benchmarks/pinchbench/scripts/run_method.sh \
  --session-mode isolated --suite automated-only
```

Claw-Eval:

```bash
bash benchmarks/claw-eval/scripts/run_baseline.sh \
  --scope suite --suite T001zh_email_triage --session-mode isolated

bash benchmarks/claw-eval/scripts/run_method.sh \
  --scope suite --suite T001zh_email_triage --session-mode isolated \
  --profile plugin
```

Add `--session-mode continuous` to run the continuous variants. Results are written below each benchmark's ignored `save/` directory and should be organized as `save/{baseline,tokenpilot}/{isolated,continuous}/`.

Benchmark-specific data requirements and commands are documented in:

- [PinchBench README](benchmarks/pinchbench/README.md)
- [Claw-Eval README](benchmarks/claw-eval/README.md)
- [runtime development guide](runtime/README.md)

## Provenance

This repository is a clean snapshot of the experiment surface formerly stored under `LightMem2/experiments`. The new repository intentionally does not carry the LightMem2 commit history.
