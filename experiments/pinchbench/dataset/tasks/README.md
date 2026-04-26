# PinchBench Tasks

This directory stores the PinchBench task definitions used by the active
experiment path.

Contents:

- `task_00_sanity.md` ... `task_22_second_brain.md`
- `TASK_TEMPLATE.md`

These files were migrated from the external benchmark harness as part of the
first PinchBench consolidation pass.

## Notes

- task markdown files are benchmark-owned assets
- they should stay dataset-scoped under `experiments/pinchbench/dataset/tasks/`
- benchmark wrapper scripts should reference these files through the main repo
  path after the executable harness is migrated
