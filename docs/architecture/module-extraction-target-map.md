# Module Extraction Target Map

## Goal

This document records where the current OpenClaw plugin modules should live if
we continue extracting runtime-agnostic logic for future multi-runtime support.

Target buckets:

1. stay in the OpenClaw adapter
2. move to `packages/layers/history`
3. move to a new shared execution/backend package (`packages/runtime-core`)

## Bucket 1: Stay In The OpenClaw Adapter

These modules are tightly coupled to OpenClaw hook wiring, provider
registration, transcript formats, session binding, or tool registration.

### Integration

- `packages/openclaw-plugin/src/context-stack/integration/config.ts`
- `packages/openclaw-plugin/src/context-stack/integration/context-engine.ts`
- `packages/openclaw-plugin/src/context-stack/integration/runtime-helpers.ts`
- `packages/openclaw-plugin/src/context-stack/integration/runtime-register.ts`
- `packages/openclaw-plugin/src/context-stack/integration/proxy-provider.ts`
- `packages/openclaw-plugin/src/context-stack/integration/proxy-runtime.ts`
- `packages/openclaw-plugin/src/context-stack/integration/trace-hooks.ts`
- `packages/openclaw-plugin/src/context-stack/integration/upstream.ts`

### Session and transcript bridging

- `packages/openclaw-plugin/src/session/topology.ts`
- `packages/openclaw-plugin/src/session/turn-bindings.ts`
- `packages/openclaw-plugin/src/context-stack/page-out/transcript-sync.ts`

### Tool/runtime registration surfaces

- `packages/openclaw-plugin/src/context-stack/page-in/recovery-tool.ts`

## Bucket 2: Move To `packages/layers/history`

These modules are primarily domain logic for canonical state, page-out, and
history rewriting. They should be host-neutral over time.

- `packages/openclaw-plugin/src/context-stack/page-out/canonical-state.ts`
- `packages/openclaw-plugin/src/context-stack/page-out/canonical-anchors.ts`
- `packages/openclaw-plugin/src/context-stack/page-out/canonical-rewrite.ts`
- `packages/openclaw-plugin/src/context-stack/page-out/canonical-eviction.ts`

### Expected future role in `layers/history`

These modules should eventually operate on neutral contracts such as:

- `TranscriptTurn`
- `CanonicalState`
- `TaskAnchor`
- `ContextRewritePlan`
- `PageOutDecision`

## Bucket 3: Move To `packages/runtime-core`

These modules are execution/backend logic. They are reusable across host
runtimes, but they do not belong in the domain layers.

### Reduction pipeline and passes

- `packages/openclaw-plugin/src/execution/reduction/*`
- `packages/openclaw-plugin/src/execution/passes/*`

### Archive recovery backend

- `packages/openclaw-plugin/src/execution/archive-recovery/*`

### Candidate follow-up extractions

These are currently mixed with OpenClaw payload handling, but parts of them can
later move into `runtime-core`.

- `packages/openclaw-plugin/src/context-stack/request-preprocessing/before-call-reduction.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/after-call-reduction.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/reduction-helpers.ts`
- `packages/openclaw-plugin/src/context-stack/page-in/recovery-common.ts`
- `packages/openclaw-plugin/src/context-stack/page-in/recovery-protocol.ts`

## Mixed Modules That Need Splitting Before Extraction

These modules currently contain both host-neutral logic and OpenClaw-specific
payload/tool structures. They should not be moved wholesale.

- `packages/openclaw-plugin/src/context-stack/request-preprocessing/stable-prefix.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/reduction-context.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/tool-results-persist.ts`

Recommended split pattern:

1. extract pure planning/transformation logic into `runtime-core`
2. keep OpenClaw payload patching in the adapter

## Recommended Extraction Order

1. create `packages/runtime-core`
2. move `execution/*` into `runtime-core`
3. define neutral contracts for history/page-out/page-in
4. move canonical/page-out domain logic into `packages/layers/history`
5. split mixed request-preprocessing modules only after the first two steps are stable

## Rule Of Thumb

Use these tests when deciding where code belongs:

- if a module knows OpenClaw hook names, plugin APIs, provider ids, transcript
  file layout, session store layout, or tool registration details, keep it in
  the adapter
- if a module only manipulates domain state and produces decisions/plans, move
  it toward `layers/history`
- if a module is an algorithmic or execution backend used by multiple flows,
  move it toward `runtime-core`
