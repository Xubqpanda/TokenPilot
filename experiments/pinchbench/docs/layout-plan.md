# PinchBench Layout Plan

This document defines the target layout for the PinchBench experiment subtree
inside the main repository.

The goal is not to import the external benchmark repository wholesale. The goal
is to create a clean, maintainable experiment surface for the parts we still
actively use.

## Scope

The first structured merge pass is intentionally limited to:

- dataset: `PinchBench`
- settings:
  - `isolated`
  - `continuous`
- method path:
  - current plugin-enabled method runs

Explicitly out of scope:

- baseline cleanup and revalidation
- `ClawEval`
- `FrontierScience`
- multi-agent and MAS variants
- old one-off ablation wrappers

## Target Layout

```text
experiments/
  pinchbench/
    README.md
    docs/
      runtime-profile.md
      migration-scope.md
      layout-plan.md
      run-notes.md
    dataset/
      assets/
      tasks/
      scripts/
    scripts/
      common.sh
      run_method.sh
      calculate_llm_cost.py
    save/
      isolated/
      continuous/
```

## Directory Responsibilities

### `experiments/pinchbench/docs/`

This directory owns:

- shared runtime profile
- migration boundary notes
- layout and ownership rules
- run notes and result interpretation

It should not contain:

- executable harness code
- benchmark result dumps

### `experiments/pinchbench/dataset/`

This directory owns:

- dataset assets
- task markdown files
- dataset-specific Python harness code

Examples:

- `tasks/task_*.md`
- `assets/*.pdf`
- `scripts/benchmark.py`
- `scripts/lib_agent.py`
- `scripts/lib_grading.py`
- `scripts/lib_tasks.py`

This is the correct place for code that is specific to PinchBench as a dataset.

### `experiments/pinchbench/scripts/`

This directory owns runnable wrapper entrypoints for the active experiment path.

It should contain:

- method-path wrapper entrypoints for `isolated` and `continuous`
- cost/report helpers
- shared shell helpers for the PinchBench method path

It should not become a dumping ground for:

- every historical ablation shell script
- wrappers for unrelated datasets
- deprecated baseline-only flows

### `experiments/pinchbench/save/`

This directory should hold curated saved experiment artifacts that remain worth
referencing.

Expected shape:

- `isolated/`
- `continuous/`

This is for structured saved outputs, not a raw log graveyard.

## Keep / Defer / Drop Policy

### Keep in the first executable merge pass

- `tasks/`
- `assets/`
- dataset-side Python harness files
- shared method-path shell helpers
- current plugin-enabled method wrappers for:
  - `isolated`
  - `continuous`

### Defer

- baseline wrappers
- method family wrappers that reflect old ablation practice
- multi-agent / MAS wrappers
- result history and full save trees

### Drop on arrival

Do not migrate these into the main repo experiment surface:

- `.venv/`
- `__pycache__/`
- `benchmark.log`
- root `log/`
- root `results/`
- root `save/`
- numbered root scripts like `run_1.sh ... run_7.sh`

## Naming Policy

Prefer neutral, function-based names for reusable harness pieces.

Use:

- `run_method.sh`
- `calculate_llm_cost.py`

Avoid:

- numbered wrappers
- brand-heavy names for reusable harness logic
- wrappers that encode historical experiment accidents into the canonical tree

Method names should appear only where method-specific behavior genuinely
exists.

## Migration Order

### Phase A

Move docs and profile assets first.

### Phase B

Move PinchBench dataset assets and task files.

### Phase C

Move dataset-side harness code:

- `benchmark.py`
- `lib_agent.py`
- `lib_grading.py`
- `lib_tasks.py`

### Phase D

Move only the active method-path wrapper surface:

- `run_method.sh`
- `common.sh`
- `calculate_llm_cost.py`

### Phase E

Revisit baseline and other datasets only after the above structure is stable.

## Validation Rules

Before moving executable code into this subtree, confirm:

1. the 3-task continual smoke still passes on the method path
2. the isolated method smoke still passes
3. `task_22` explicit `new_session` still grades correctly
4. judge setup still avoids mutating global runtime config
5. migrated wrappers no longer assume a sibling external benchmark checkout
