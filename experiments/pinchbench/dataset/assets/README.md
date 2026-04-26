# PinchBench Assets

This directory stores the static input assets used by the active PinchBench
task set.

Current contents include:

- PDF inputs
- text files
- spreadsheet and CSV files

These files were migrated from the external benchmark harness as part of the
first PinchBench consolidation pass.

## Notes

- assets here are benchmark-owned dataset inputs
- they should remain dataset-scoped under
  `experiments/pinchbench/dataset/assets/`
- local caches, generated logs, and downloaded virtualenv content do not belong
  in this directory
