# Runtime Rename Migration Plan

## Goal

Define how to migrate the remaining legacy runtime identifiers without
breaking:

- installed OpenClaw plugin runtimes
- benchmark scripts
- persisted state paths
- workspace package imports
- old experiment artifacts and logs

This plan is intentionally separate from brand-layer cleanup.

## Scope

This plan only covers runtime-facing names such as:

- plugin id
- context-engine id
- provider prefix
- environment-variable prefixes
- workspace package names
- persisted state / marker strings

It does not cover README or documentation-only wording.

## Current High-Risk Runtime Surface

### Plugin/runtime ids

- plugin id: `tokenpilot`
- context-engine id: `layered-context`
- provider namespace: `tokenpilot/*`

### Environment variables

- `ECOCLAW_*`

### Workspace package imports

This migration has already landed:

- `@tokenpilot/kernel`
- `@tokenpilot/history`
- `@tokenpilot/decision`
- `@tokenpilot/runtime-core`

### Persisted paths and markers

- `~/.openclaw/ecoclaw-plugin-state`
- `stateDir/ecoclaw/...`
- `.ecoclaw-archives`
- `[persisted tool result]`
- `[Recovery Protocol]`
- `runtime-pfx-*`

## Design Rule

The migration should be:

1. dual-read
2. dual-register where possible
3. single-write only after compatibility is established
4. legacy-removal only after repeated smoke validation

Do not do a global search-and-replace rename.

## Migration Phases

### Phase 1: Add Neutral Or New Aliases

Introduce support for the new runtime naming surface without removing old
names.

Target aliases:

- plugin-facing brand alias: `tokenpilot`
- context-engine alias: `layered-context`
- provider alias: `tokenpilot/*`
- env aliases: `TOKENPILOT_*`

Rules:

- old names remain fully supported
- new names are accepted in config and scripts
- docs begin preferring new names only after they are validated

### Phase 2: Adapter-Level Compatibility

Update the OpenClaw adapter to accept both old and new names.

Expected changes:

- register both provider aliases if OpenClaw allows it
- accept both context-engine ids where possible
- read both `ECOCLAW_*` and `TOKENPILOT_*`
- prefer new values when both are present

If full dual registration is impossible at the host API level, keep old runtime
ids and only dual-read config/env values first.

### Phase 3: Workspace Package Transition

Completed.

Workspace package names were migrated separately from runtime ids, using:

1. temporary dual path aliases
2. incremental import migration
3. manifest rename after imports were clean

This migration should stay decoupled from plugin/runtime-id migration.

### Phase 4: Persisted State Strategy

Persisted names and markers need a compatibility policy.

Preferred order:

1. keep reading old locations and markers
2. keep writing old locations during the transition
3. only switch writes after repeated compatibility validation
4. optionally add a one-time migrator later

Do not change persisted markers and directory basenames in the same batch as
provider/context-engine renames.

### Phase 5: Legacy Removal

Only after all earlier phases are stable:

- stop documenting old names
- stop generating old aliases in new configs
- remove legacy support gradually

## Recommended Alias Policy

### Provider prefix

Provider namespace migration has already landed:

- runtime registration now uses `tokenpilot/*`
- legacy `ecoclaw/*` handling is only kept in normalization paths where needed

### Context engine

Context-engine slot migration has already landed:

- runtime registration now uses `layered-context`
- benchmark/runtime config patchers now write `layered-context`

### Environment variables

Dual-read policy:

- read `TOKENPILOT_*` first
- fallback to `ECOCLAW_*`

This is the safest runtime rename step and should happen early.

### Package names

Package names are no longer blocked. The active workspace namespace is already
`@tokenpilot/*`.

## Validation Matrix

Each phase should end with a concrete validation pass.

### Static validation

- `pnpm -C packages/kernel typecheck`
- `pnpm -C packages/layers/history typecheck`
- `pnpm -C packages/layers/decision typecheck`
- `pnpm -C packages/runtime-core typecheck`
- `pnpm -C packages/openclaw-plugin typecheck`

### Build validation

- `pnpm -C packages/layers/history build`
- `pnpm -C packages/runtime-core build`
- `pnpm -C packages/openclaw-plugin build`

### Runtime install validation

- `pnpm -C packages/openclaw-plugin install:release`
- `openclaw config validate`

### Benchmark smoke validation

Run at minimum:

1. method + continuous + first 3 tasks
2. baseline + continuous + first 3 tasks
3. method + isolated + first 3 tasks
4. baseline + isolated + first 3 tasks

### Runtime behavior checks

Confirm:

- provider registration still works
- context-engine slot still resolves
- `input + cache` accumulates in continual mode
- transcript lock issue does not regress
- canonical rewrite / eviction trace still appears
- `memory_fault_recover` registration still works

## What To Avoid

Do not combine these into one commit series:

1. workspace package rename
2. provider/context-engine rename
3. persisted marker rename
4. path/layout rename
5. env dual-read support

These need separate review and validation.

## Recommended Next Concrete Step

The safest runtime rename work to start with is:

1. add dual-read support for `TOKENPILOT_*` alongside `ECOCLAW_*`
2. keep all runtime ids unchanged
3. validate benchmark smoke

After that, evaluate whether provider/context-engine dual registration is even
possible in the host runtime.

## Summary

The rename is now blocked not by architecture, but by compatibility risk.

The project is ready for a staged runtime rename, but only if it proceeds in
this order:

1. env alias support
2. adapter compatibility
3. package import migration
4. persisted state strategy
5. legacy removal
