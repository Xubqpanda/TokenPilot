# Migration Provenance

The initial benchmark snapshot was copied from:

```text
source_repository: https://github.com/zjunlp/LightMem2
source_path: experiments/tokenpilot/
source_commit: 455ce88
migration_mode: clean snapshot without source Git history
```

The source `experiments/tokenpilot/pinchbench` and `experiments/tokenpilot/claw-eval` trees were imported into `benchmarks/`. Historical wrappers are intentionally excluded from the public snapshot and ignored locally under `legacy/`; they are not part of the official reproduction API.

The LightMem2 runtime is intentionally not copied into this repository. During development, set `TOKENPILOT_RUNTIME_ROOT` to a local LightMem2 checkout.
