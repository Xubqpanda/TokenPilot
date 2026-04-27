# Kernel And Dead Framework Audit

## Summary

The current repository still contains a small group of early runtime-framework
artifacts that are not part of the live plugin or experiments mainline.

This audit separates:

1. active shared kernel contracts
2. dead or inactive framework packages
3. kernel files that should be revisited later

## Active Kernel Surface To Keep

These files are still valuable as shared cross-package contracts or helpers.

- `packages/kernel/src/events.ts`
- `packages/kernel/src/types.ts`
- `packages/kernel/src/segments.ts`
- `packages/kernel/src/api-family.ts`

These provide:

- runtime event schemas
- shared primitive types
- context segment helpers
- API-family normalization

## Dead Framework Packages

These packages are not imported by the live OpenClaw plugin mainline, the
migrated `experiments/pinchbench` path, or the active layers.

### Providers

- `packages/providers/openai`
- `packages/providers/anthropic`

They define `ProviderAdapter` implementations for an older kernel-side runtime
pipeline, but no live code imports them.

### Storage

- `packages/storage/fs`

It implemented `RuntimeStateStore`, but the live plugin no longer used that
abstraction. The current runtime writes state directly via plugin-local
canonical/trace/artifact files.

## Kernel Files To Revisit Later

These files belong to an older prototype runtime pipeline. They are not the
current canonical execution spine, but some of their types are still imported.

- `packages/kernel/src/interfaces.ts`

### Why they are not deleted yet

- `RuntimeModule` and `RuntimeModuleRuntime` are still imported in active code
- the unused `RuntimeStateStore` dependency has already been removed from active reduction code
- the unused pipeline/scheduler prototype has already been removed

## Recommended Cleanup Order

1. remove dead provider/storage packages
2. remove dead path aliases for those packages
3. keep the active kernel contracts intact
4. later revisit whether `interfaces.ts` should remain as the home for the two remaining live module contracts

## Current rule

Until a new runtime-core extraction begins:

- keep `kernel` as the shared contract/helper layer
- treat `providers/*` and `storage/fs` as removable dead framework residue
- treat `kernel/interfaces.ts`, `pipeline.ts`, and `scheduler.ts` as deferred cleanup
