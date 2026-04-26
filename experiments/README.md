# Experiments

This directory is the future home for benchmark and evaluation assets that are
currently maintained in the separate benchmark harness repository.

Planned migration targets include:

- `dataset/`
- `scripts/`
- `results/`
- `save/`

Current rule:

- keep the live benchmark harness in the separate repository until path
  assumptions and runtime setup have been revalidated under the `TokenPilot`
  brand
- treat this directory as a structural placeholder, not an active benchmark
  entrypoint

## Active Consolidation Target

The first active consolidation target is:

- `experiments/pinchbench/`

That subtree is where the PinchBench-only migration will land first, with the
scope intentionally reduced to:

- dataset: `PinchBench`
- settings: `isolated` and `continuous`
- method path only

Baseline cleanup and the other datasets are intentionally deferred.

The current planning docs for that subtree are:

- `experiments/pinchbench/docs/runtime-profile.md`
- `experiments/pinchbench/docs/migration-scope.md`
- `experiments/pinchbench/docs/layout-plan.md`
