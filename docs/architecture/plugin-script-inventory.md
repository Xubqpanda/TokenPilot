# Plugin Script Inventory

## Purpose

This document records the current status of scripts under:

```text
packages/openclaw-plugin/scripts/
```

The goal is to separate:

- active development helpers
- release helpers
- acceptance helpers

from the benchmark-side experiment harness in `EcoClaw-Bench`.

## Active Release Helpers

These are still part of the package install/release path and should remain
discoverable:

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/pack_release.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/install_release.sh`

Package script bindings:

- `npm run pack:release`
- `npm run install:release`

## Acceptance Helpers

These scripts are retained as legacy plugin-side validation helpers. They are
not part of the main benchmark harness, they are not part of the published
plugin payload, and they are no longer exposed as package scripts.

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/e2e.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/cache_acceptance.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/acceptance_report.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/semantic_e2e.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/summary_e2e.sh`

Current package script bindings:

- none

## Current Assessment

These scripts are not dead code in the narrow sense, because:

- they still encode targeted local validation flows
- some are still useful as implementation references for future `experiments/`

But they should be treated as:

- plugin-side development tooling
- legacy targeted acceptance checks
- not as the canonical project evaluation path

The canonical benchmark/evaluation flow now belongs in `EcoClaw-Bench`, and in
the future should move into the main repo under `experiments/`.

The published plugin package should stay narrow:

- runtime files in `dist/`
- `openclaw.plugin.json`
- plugin README

Acceptance helpers and fixtures should remain local development tooling.

## Cleanup Guidance

Near-term guidance:

1. keep release helpers intact
2. keep acceptance helpers available only as legacy dev tooling on disk
3. stop expanding these scripts with benchmark-specific logic
4. move benchmark documentation and benchmark runtime setup out of this package

Later cleanup options:

1. rename acceptance scripts to align with the future `TokenPilot` brand
2. delete semantic/summary/cache acceptance helpers once equivalent checks live
   under the future top-level `experiments/` tree
3. move any remaining benchmark-like flows into the future top-level
   `experiments/` tree
