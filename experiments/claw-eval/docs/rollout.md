# Claw-Eval Rollout

Canonical local data layout:
- `experiments/claw-eval/dataset/tasks`
- `experiments/claw-eval/dataset/general`

The adapter should use the local mirrored dataset above as its runtime source of truth.
Do not introduce a second `dataset/upstream/` task tree.

Phases:
1. scaffold
2. task.yaml loader
3. text-only pilot tasks
4. service-backed pilot tasks
5. broader split/category rollout

This adapter should remain schema-separated from `experiments/pinchbench/`.

## Mock Service Split

The plugin split changes tool exposure, not backend semantics.

- Original behavior still lives in upstream FastAPI services under `claw-eval/mock_services/`.
- `claw-eval-mock-tools` is the aggregate OpenClaw wrapper over those HTTP endpoints.
- Per-service plugins such as `claw-eval-mock-tools-notes`, `-helpdesk`, and `-crm` are thin shims that only re-export tools matching a name prefix.

Implication:

- If service base URLs are correct, the split plugins should behave the same as the original mock services.
- The new risks are adapter-layer risks:
  - wrong tool-name to plugin mapping
  - wrong plugin install/enable plan
  - wrong service URL wiring

That is why the adapter rollout starts with plugin-closure resolution before any runtime mutation.
