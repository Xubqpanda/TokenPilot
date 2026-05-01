# Claw-Eval Adapter Plan

## Goal

Introduce `claw-eval` as a **second benchmark adapter** under `TokenPilot/experiments/`, without mixing its task schema into the existing `pinchbench` runner.

This is **not** a dataset extension of PinchBench.  
It is a parallel benchmark integration with its own:

- task loader
- fixture model
- grader runtime
- suite semantics
- reporting schema

The intention is to reuse stable infra where it makes sense, while keeping the benchmark schema boundary explicit.

---

## Proposed Layout

Add a new top-level benchmark adapter:

```text
TokenPilot/
  experiments/
    pinchbench/
    claw-eval/
      dataset/
        upstream/          # synced claw-eval source snapshot or selected task mirror
        tasks/             # local selected task set / filtered mirror
      scripts/
        benchmark.py       # claw-eval runner entrypoint
        lib_tasks.py       # task.yaml + grader.py adapter
        lib_agent.py       # task execution wrapper
        lib_grading.py     # direct API judge bridge for claw-eval graders
        lib_services.py    # mock-tool / sandbox wiring
      save/
        isolated/
        continuous/        # only if we intentionally define such a mode later
        logs/
        reports/
      docs/
        rollout.md
        supported-tasks.md
```

Short version:

- `pinchbench/` stays as-is
- `claw-eval/` is a sibling adapter
- only stable cross-benchmark infra should be reused

---

## What To Reuse

These are worth reusing from current TokenPilot work.

### 1. Direct judge client

Reuse the current direct API judge path instead of reintroducing OpenClaw judge agents.

Why:

- avoids `agents.list` churn
- avoids gateway reload during grading
- already validated in PinchBench

This should become the default judge backend for claw-eval textual grading.

### 2. Runtime env normalization

Reuse the stable runtime env handling patterns:

- `HOME/.openclaw` normalization
- `OPENCLAW_CONFIG_PATH`
- config backup / restore discipline
- plugin install / release workflow

These should be shared as small shell helpers or copied carefully into `claw-eval/scripts/common.sh`.

### 3. Wrapper style

Reuse the current script conventions:

- `run_*` wrapper scripts
- per-run log file
- pid file
- background-safe entrypoints

This matters more than it looks. It keeps intern usage and batch execution manageable.

### 4. Plugin install flow

Reuse:

- `corepack pnpm -C TokenPilot/packages/openclaw-plugin install:release`

for method-side runs that need TokenPilot loaded.

### 5. Category-aware reporting style

PinchBench already established a useful pattern:

- benchmark score summary
- token efficiency summary
- later category aggregation

Claw-Eval does not need the same schema, but the reporting posture should stay similar.

---

## What Not To Reuse

These boundaries should remain explicit.

### 1. Do not merge schemas

Do **not** force claw-eval tasks into PinchBench task markdown format.

PinchBench:

- `manifest.yaml`
- `task_*.md`

Claw-Eval:

- `tasks/<id>/task.yaml`
- `tasks/<id>/grader.py`

Trying to unify them into one dataset model will make both worse.

### 2. Do not reuse PinchBench suite semantics blindly

PinchBench uses:

- `all`
- `automated-only`
- `session-mode=isolated|continuous`

Claw-Eval has very different structure:

- `general`
- `multimodal`
- `multi_turn`
- richer task-level scoring dimensions

Claw-Eval adapter should define its own suite semantics.

### 3. Do not reintroduce OpenClaw judge agent flow

This was already shown to be a structural stability problem in PinchBench.

Keep:

- direct API judge

Avoid:

- `ensure_judge_agent(...)`
- helper-agent grading

### 4. Do not start with the whole 300-task benchmark

Claw-Eval includes:

- multimodal tasks
- video/image tasks
- multi-turn tasks
- external services
- custom graders

A full import first is the wrong order.

---

## Source Material To Mine

We have two useful upstreams:

### A. Official source

Path:

- `/mnt/20t/xubuqiang/EcoClaw/claw-eval`

Take from it:

- `task.yaml` schema
- `grader.py` conventions
- split/category taxonomy
- task fixtures model

### B. Internal prototype / intern code

Path:

- `/mnt/20t/xubuqiang/EcoClaw/代码打包/代码打包`

Take from it selectively:

#### Good candidates

- `scripts/lib_tasks.py`
  - official `task.yaml` loader idea
- `plugins/claw-eval-mock-tools*`
  - mock-tool plugin decomposition
- `scripts/lib_agent.py`
  - task-aware plugin exposure based on declared tools

#### Do not import wholesale

- old benchmark mainline
- old judge agent flow
- old openclaw config mutation patterns

The intern code is useful as a **component mine**, not as the new benchmark spine.

---

## Adapter Contract

The `claw-eval` adapter should expose a narrow internal contract.

### Task object

Needed minimum fields:

- `task_id`
- `task_name`
- `category`
- `split`
- `prompt`
- `declared_tools`
- `fixtures`
- `language`
- `grader_path`
- `timeout_seconds`

### Execution result object

Needed minimum fields:

- `task_id`
- `status`
- `workspace`
- `transcript`
- `dispatches`
- `stdout`
- `stderr`
- `usage`
- `execution_time`

### Grading result object

Needed minimum fields:

- `completion`
- `safety`
- `robustness`
- `overall`
- `notes`

Do not try to collapse this immediately into PinchBench's `mean/criteria_scores`.

---

## Phase Plan

### Phase 0: Scaffold Only

Create:

- `experiments/claw-eval/`
- `scripts/`
- `docs/`
- `save/`

No task migration yet.

Deliverable:

- empty adapter skeleton with a README/rollout note

### Phase 1: Loader-Only Pilot

Implement:

- `task.yaml` loader
- task directory discovery
- local task selection

Do **not** run real benchmark yet.

Deliverable:

- list tasks
- filter by split/category
- sanity-validate `grader.py` path existence

### Phase 2: Minimal Text-Only Pilot

Pick **1-3 low-risk tasks**:

- text-only
- no multimodal
- no user-agent
- minimal service dependencies

Goal:

- prove direct API judge path can satisfy claw-eval grader expectations
- prove workspace/dispatch/transcript wiring is enough

Good initial candidates are likely from:

- `general`
- non-multimodal
- non-multi_turn

Avoid at first:

- image/video
- multi-turn persona
- complex service-backed tasks

### Phase 3: Service-Backed Pilot

Bring in:

- selected mock-tool plugins
- task-aware plugin exposure

Goal:

- validate that declared tools -> plugin enablement works

### Phase 4: Split-Aware Expansion

Expand in this order:

1. `general`
2. selected service-backed `general`
3. limited `multimodal`
4. `multi_turn`

### Phase 5: Reporting and Comparison

Add:

- per-split summaries
- per-category summaries
- token/cost summaries
- method vs baseline comparison tables

---

## Initial Task Selection Policy

The first claw-eval pilot should be intentionally narrow.

### Include first

- text-only
- English tasks first
- deterministic or lightly judge-based graders
- no video/image
- no persona loop

### Exclude first

- multimodal document/video/image tasks
- visual judge tasks
- multi-turn user-agent tasks
- tasks with heavy sandbox/service assumptions

The point is to first prove:

- loader
- workspace
- transcript
- direct judge bridge

before dealing with the harder modality/runtime surfaces.

---

## Reporting Strategy

Do not force claw-eval reports into PinchBench report names.

Suggested output structure:

```text
experiments/claw-eval/save/
  isolated/
    baseline/
      raw/
    method/
      raw/
  logs/
  reports/
```

Suggested summary axes:

- by split
- by category
- by dimension:
  - completion
  - safety
  - robustness

PinchBench-style token/cost summaries can still be added, but the primary score model should remain claw-eval-native.

---

## Risks

### 1. Grader expectations may be richer than PinchBench result objects

Some claw-eval graders expect:

- dispatch records
- multimodal artifacts
- service traces
- richer audit data

This is likely the hardest adapter boundary.

### 2. Mock-tool semantics may not match OpenClaw-native tools exactly

Task pass/fail can drift if service behavior is only approximately simulated.

### 3. Multi-turn tasks are not just "continuous mode"

Claw-Eval `multi_turn` likely implies:

- a simulated user agent
- clarification loop
- stateful interaction semantics

This should not be approximated too early with the PinchBench continuous harness.

---

## Recommended Immediate Next Step

Do **not** start by copying 300 tasks.

Start with:

1. create `experiments/claw-eval/` skeleton
2. implement `task.yaml` loader
3. select 1-3 text-only tasks
4. make direct-judge grading work on those tasks

That is the first meaningful proof point.

If that works, the rest becomes an expansion problem rather than a design gamble.
