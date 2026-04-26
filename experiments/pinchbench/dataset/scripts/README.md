# PinchBench Dataset Scripts

This directory is the main-repo landing zone for the PinchBench dataset-side
Python harness.

The first migrated files are:

- `benchmark.py`
- `lib_agent.py`
- `lib_grading.py`
- `lib_tasks.py`

## Current Status

These files are not yet a fully cleaned mainline harness.

The current status is split:

- `benchmark.py` has already been narrowed to the single-agent method path
- `lib_agent.py` has already been narrowed to the single-agent execution path
- `lib_grading.py` no longer carries MAS-specific transcript summarization

Remaining deferred branches that are outside the first consolidation scope
include:

- upload-related integration points
- historical harness switches that are not part of the narrowed method path

## First-Pass Rule

For the first executable consolidation pass, this directory should converge on:

- PinchBench only
- `isolated` mode
- `continuous` mode
- current plugin-enabled method path

Anything outside that boundary should be treated as deferred until the active
path is extracted and validated.

## Immediate Follow-up Cleanup

Before these scripts become the canonical runnable harness inside the main repo,
we should:

1. isolate upload-only code from the active run path
2. reduce historical wrapper assumptions inherited from the external harness
3. revalidate the 3-task continual smoke against the migrated tree
