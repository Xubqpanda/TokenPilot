# OpenClaw Plugin Extraction Inventory

## Purpose

This document records the current extraction boundary after the context-stack,
`runtime-core`, and `layers/history` split.

It answers three questions:

1. what is already extracted out of the OpenClaw adapter
2. what is intentionally still adapter-only
3. what remains mixed and should only be split with care

## Current Layering

The repository now has four active buckets:

1. `packages/kernel`
2. `packages/layers/*`
3. `packages/runtime-core`
4. `packages/openclaw-plugin`

The intended role of `packages/openclaw-plugin` is now narrow:

- OpenClaw hook wiring
- OpenClaw provider/context-engine integration
- OpenClaw transcript/session adaptation
- OpenClaw request/response payload patching
- OpenClaw tool registration

## Already Extracted Out Of The Adapter

### Shared contracts in `packages/kernel`

- `packages/kernel/src/runtime-contracts.ts`
- `packages/kernel/src/events.ts`
- `packages/kernel/src/types.ts`
- `packages/kernel/src/segments.ts`
- `packages/kernel/src/api-family.ts`
- `packages/kernel/src/interfaces.ts`

These now hold the minimum shared contracts and primitives.

### History/page-out domain logic in `packages/layers/history`

- `packages/layers/history/src/page-out-types.ts`
- `packages/layers/history/src/canonical-state.ts`
- `packages/layers/history/src/canonical-anchors.ts`
- `packages/layers/history/src/canonical-rewrite.ts`
- `packages/layers/history/src/canonical-eviction.ts`
- `packages/layers/history/src/reduction-anchors.ts`

These are no longer primarily OpenClaw adapter code.

### Shared execution/backend logic in `packages/runtime-core`

- `packages/runtime-core/src/reduction/*`
- `packages/runtime-core/src/passes/*`
- `packages/runtime-core/src/archive-recovery/*`
- `packages/runtime-core/src/page-in/recovery-common.ts`

In addition, these smaller extractions already landed:

- reduction enablement
- tool-result persistence policy
- recovery marker/common helpers

## Adapter-Only Modules

These files are intentionally still part of the OpenClaw adapter.

### Integration

- `packages/openclaw-plugin/src/context-stack/integration/config.ts`
- `packages/openclaw-plugin/src/context-stack/integration/context-engine.ts`
- `packages/openclaw-plugin/src/context-stack/integration/runtime-helpers.ts`
- `packages/openclaw-plugin/src/context-stack/integration/runtime-register.ts`
- `packages/openclaw-plugin/src/context-stack/integration/proxy-provider.ts`
- `packages/openclaw-plugin/src/context-stack/integration/proxy-runtime.ts`
- `packages/openclaw-plugin/src/context-stack/integration/trace-hooks.ts`
- `packages/openclaw-plugin/src/context-stack/integration/upstream.ts`

Reason:
These know OpenClaw hook names, provider ids, context-engine registration, and
runtime wiring.

### Transcript/session bridge

- `packages/openclaw-plugin/src/context-stack/page-out/transcript-sync.ts`
- `packages/openclaw-plugin/src/session/topology.ts`
- `packages/openclaw-plugin/src/session/turn-bindings.ts`

Reason:
These depend on OpenClaw transcript/session behavior and are not host-neutral.

### Page-in adapter surface

- `packages/openclaw-plugin/src/context-stack/page-in/recovery-protocol.ts`
- `packages/openclaw-plugin/src/context-stack/page-in/recovery-tool.ts`

Reason:
These patch OpenClaw instructions/payloads and register OpenClaw tools.

### Shared infra that does not need forced extraction

- `packages/openclaw-plugin/src/trace/io.ts`

Reason:
This is shared adapter-side infra, not domain logic.

## Mixed Modules Still In The Adapter

These modules are still worth keeping in `openclaw-plugin`, but for a different
reason: they mix useful orchestration logic with OpenClaw payload patching.

### Request preprocessing

- `packages/openclaw-plugin/src/context-stack/request-preprocessing/before-call-reduction.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/after-call-reduction.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/reduction-context.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/stable-prefix.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/tool-results-persist.ts`

Status:

- `tool-results-persist.ts` is now mostly an adapter wrapper over
  `runtime-core` persistence policy.
- `before-call-reduction.ts` and `after-call-reduction.ts` still orchestrate
  shared reduction backends while directly patching OpenClaw request/response
  payloads.
- `reduction-context.ts` still understands OpenClaw/OpenAI-style input item
  shapes, tool blocks, persisted markers, and recovery markers.
- `stable-prefix.ts` is still message/payload-shape aware.

These files should not be moved wholesale.

## Practical Boundary Rule

A module should remain in `packages/openclaw-plugin` if it does any of the
following:

- reads or mutates OpenClaw payload shape directly
- knows OpenClaw hook names or plugin APIs
- registers providers, context engines, or tools
- parses OpenClaw transcript/session storage layouts
- depends on OpenClaw-specific message or block conventions

A module should move out when it only does one of the following:

- manipulates host-neutral domain state
- computes reduction/page-out/page-in plans
- implements reusable execution/backend logic
- operates on shared runtime contracts without OpenClaw APIs

## Current Split Quality

### Already in good shape

- `Page Out` canonical flow
- execution backend
- recovery common markers
- reduction enablement
- tool-result persistence policy

### Still intentionally adapter-heavy

- request/response reduction patching
- transcript salvage
- session continuity bridge
- tool registration
- provider/runtime wiring

## Next Extraction Candidates

If we continue extracting later, the highest-value remaining work is not a full
module move. It is careful function-level splitting inside request
preprocessing.

Likely future targets:

1. further isolate reduction planning from payload patching
2. keep OpenClaw response/request mutation in the adapter
3. avoid moving `after-call-reduction.ts` wholesale, because it is strongly tied
   to SSE and response patching

## Summary

The adapter is no longer the main home for canonical page-out logic or
execution backends.

`packages/openclaw-plugin` is now much closer to a real host adapter:

- integration
- transcript/session adaptation
- payload patching
- tool/provider/context-engine registration

That is the intended steady-state direction for later Hermes or OpenJiuwen
support.
