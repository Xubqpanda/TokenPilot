# Workspace Package Rename Plan

## Goal

Rename the shared workspace packages away from the `@ecoclaw/*` namespace
without coupling that migration to:

- plugin runtime id migration
- persisted state migration
- host runtime config migration

This is a repository/build migration, not a host-runtime migration.

## Current Workspace Package Surface

The active package namespace is now:

- `@tokenpilot/kernel`
- `@tokenpilot/history`
- `@tokenpilot/decision`
- `@tokenpilot/runtime-core`

These names currently appear in three places:

1. package manifests
2. `tsconfig.base.json` path aliases
3. source imports across `layers/*`, `runtime-core`, and `openclaw-plugin`

## Important Constraint

Do not mix workspace package renames into the same batch as:

- plugin id rename
- persisted marker rename
- state-path rename
- `ECOCLAW_*` legacy removal

Those are separate migration classes.

## Recommended Target Names

Prefer neutral names where possible.

Recommended targets:

- `@tokenpilot/kernel`
- `@tokenpilot/history`
- `@tokenpilot/decision`
- `@tokenpilot/runtime-core`

Rationale:

- `kernel` is already neutral
- `history` is a better long-term domain name than `layer-history`
- `decision` is a better long-term domain name than `layer-decision`
- `runtime-core` already matches the current package role

## Migration Strategy

### Phase 1: Dual Path Alias Support

Completed.

`tsconfig.base.json` temporarily resolved both:

- old: `@ecoclaw/*`
- new: `@tokenpilot/*`

### Phase 2: Source Import Migration

Completed.

Source imports were migrated package by package:

1. `packages/layers/history`
2. `packages/layers/decision`
3. `packages/runtime-core`
4. `packages/openclaw-plugin`

### Phase 3: Manifest Rename

Completed.

Package manifest `name` fields and workspace dependency declarations now use
the `@tokenpilot/*` namespace.

### Phase 4: Remove Legacy Path Aliases

Completed.

Legacy `@ecoclaw/*` path aliases have been removed from `tsconfig.base.json`.

## Validation Matrix

After each phase, run:

### Static

- `pnpm -C packages/kernel typecheck`
- `pnpm -C packages/layers/history typecheck`
- `pnpm -C packages/layers/decision typecheck`
- `pnpm -C packages/runtime-core typecheck`
- `pnpm -C packages/openclaw-plugin typecheck`

### Build

- `pnpm -C packages/layers/history build`
- `pnpm -C packages/layers/decision build`
- `pnpm -C packages/runtime-core build`
- `pnpm -C packages/openclaw-plugin build`

### Plugin Install

- `pnpm -C packages/openclaw-plugin install:release`

### Smoke

- method + continuous + first 3 tasks

## Current Recommendation

The workspace package rename is now landed at the source/build level.

Remaining rename work is no longer about workspace imports. It has moved to:

1. plugin/runtime ids
2. persisted markers and state paths
3. final documentation cleanup
