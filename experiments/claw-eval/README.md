# Claw-Eval Adapter

This directory is a parallel benchmark adapter for integrating the `claw-eval`
dataset into TokenPilot without mixing its task schema into the existing `pinchbench`
runner.

Canonical local dataset layout:
- `dataset/tasks/`: local task source of truth (`300` task folders with `task.yaml`)
- `dataset/general/`: shared flat assets mirrored for general/file-heavy tasks

Current status:
- pilot adapter exists
- `task.yaml` loading and suite selection work
- plugin closure resolution and run-scoped plugin activation work for a limited subset
- isolated pilot execution has been validated for a limited service-backed subset
- grading bridge is usable for the current baseline subset
- broader schema coverage is still in progress

Current limitations:
- supported task surface is still intentionally subset-based
- `env_snapshot`, `user_agent`, and media/attachment coverage are incomplete
- multimodal and broader file-artifact tasks are not fully supported yet

See:
- `docs/rollout.md`
- `../../docs/experiments/claw-eval-adapter-plan.md`
