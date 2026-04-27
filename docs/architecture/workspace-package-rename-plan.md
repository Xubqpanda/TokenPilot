# Workspace Package Rename Plan

## Goal

Rename the shared workspace packages away from the `@ecoclaw/*` namespace
without coupling that migration to:

- plugin runtime id migration
- persisted state migration
- host runtime config migration

This is a repository/build migration, not a host-runtime migration.

## Current Workspace Package Surface

The active package namespace is:

- `@ecoclaw/kernel`
- `@ecoclaw/layer-history`
- `@ecoclaw/layer-decision`
- `@ecoclaw/runtime-core`

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

Update `tsconfig.base.json` so both old and new import names resolve:

- old: `@ecoclaw/*`
- new: `@tokenpilot/*`

Do not change package manifest names yet.

Goal:

- allow source migration incrementally
- keep old imports working during the transition

### Phase 2: Source Import Migration

Migrate source imports package by package:

1. `packages/layers/history`
2. `packages/layers/decision`
3. `packages/runtime-core`
4. `packages/openclaw-plugin`

This should be done in small batches with typecheck/build after each slice.

### Phase 3: Manifest Rename

After source imports no longer use `@ecoclaw/*`:

1. rename package manifest `name` fields
2. update workspace dependency declarations
3. re-run all package builds and plugin release packaging

### Phase 4: Remove Legacy Path Aliases

Only after the codebase is fully migrated:

- remove `@ecoclaw/*` from `tsconfig.base.json`

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

Do not rename workspace package manifests first.

Start with:

1. dual path aliases in `tsconfig.base.json`
2. import migration
3. manifest rename only after imports are clean

This keeps the migration reversible and avoids breaking release packaging too
early.
