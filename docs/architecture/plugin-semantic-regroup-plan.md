# Plugin Semantic Regroup Plan

This document defines the next structural cleanup target for the plugin
runtime. It is a **design plan**, not an immediate file-move checklist.

The current plugin is already operationally cleaner than before:

- the large `index.ts` split is complete
- legacy command flow is removed
- legacy acceptance harness is removed
- obvious dead config surface is gone

The next question is not "how to split more files", but:

- which semantic boundaries should become first-class
- which current directories already match those boundaries
- which regrouping steps are worth the validation cost

## Design Principles

1. keep runtime behavior stable while clarifying module meaning
2. prefer semantic entrypoints before physical file moves
3. avoid a second large directory reorganization until benchmark validation is cheap again
4. keep request preprocessing, page-out, and page-in concerns explicitly separate

## Context Management Model

The current runtime should be described as:

1. a three-part context management stack
2. one integration layer

### 1. Request Preprocessing

Responsibility:

- payload normalization
- stable prefix shaping
- before-call reduction
- after-call reduction
- tool-result ingress shaping

Current files:

- `src/context-stack/request-preprocessing/stable-prefix.ts`
- `src/context-stack/request-preprocessing/before-call-reduction.ts`
- `src/context-stack/request-preprocessing/after-call-reduction.ts`
- `src/context-stack/request-preprocessing/reduction-context.ts`
- `src/context-stack/request-preprocessing/reduction-helpers.ts`
- `src/context-stack/request-preprocessing/tool-results-persist.ts`
- `src/context-stack/request-preprocessing/root-prompt-stabilizer.ts`

This stage happens before content becomes durable history.

### 2. Page Out

Responsibility:

- transcript ingestion
- raw semantic turn sync
- canonical state persistence
- canonical rewrite
- task-aware eviction
- session / turn binding needed to preserve one history timeline
- stub/reference creation for evicted context

Current files:

- `src/context-stack/page-out/transcript-sync.ts`
- `src/context-stack/page-out/canonical-state.ts`
- `src/context-stack/page-out/canonical-anchors.ts`
- `src/context-stack/page-out/canonical-rewrite.ts`
- `src/canonical/eviction.ts`
- `src/session/topology.ts`
- `src/session/turn-bindings.ts`

This stage is the "active context -> cold context" path.

### 3. Page In

Responsibility:

- archive lookup
- recovery marker protocol
- memory-fault recovery tool
- future semantic retrieve / selective recall

Current files:

- `src/context-stack/page-in/recovery-common.ts`
- `src/context-stack/page-in/recovery-protocol.ts`
- `src/context-stack/page-in/recovery-tool.ts`
- `src/execution/archive-recovery/*`

This stage rehydrates content after it has been paged out.

## Integration Layer

Responsibility:

- config normalization
- runtime hook registration
- provider wiring
- embedded proxy orchestration
- context-engine bootstrap

Current files:

- `src/config.ts`
- `src/context-engine.ts`
- `src/runtime/helpers.ts`
- `src/runtime/register.ts`
- `src/proxy/runtime.ts`
- `src/proxy/provider.ts`
- `src/proxy/upstream.ts`
- `src/index.ts`

## Target Regroup Shape

The desired end state is not necessarily a total directory move. The desired end
state is a clearer semantic entry surface.

### Option A: Facade-First Regroup

Add semantic entrypoints without moving the underlying files yet.

Current target shape:

```text
src/
  context-stack/
    request-preprocessing.ts
    page-out.ts
    page-in.ts
    integration.ts
    index.ts
```

Each facade would re-export the currently live modules from their existing
locations.

Benefits:

- very low migration risk
- benchmark/runtime behavior stays stable
- future physical moves become mostly mechanical

Drawbacks:

- some duplication between semantic facades and technical directories

### Option B: Partial Physical Regroup

Move only the most semantically obvious outliers.

Likely first candidates:

- `src/context-stack/request-preprocessing/tool-results-persist.ts`
- `src/context-stack/page-out/transcript-sync.ts`

Benefits:

- clearer directory meaning

Drawbacks:

- import churn starts immediately
- harder to validate incrementally

### Recommendation

Use **Option A first**.

The next useful step is:

1. define semantic facades
2. keep underlying files where they are
3. validate benchmark behavior
4. only then decide whether any physical regroup is worth it

## What Should Not Be Mixed

The regrouping should preserve these hard distinctions.

### Request preprocessing vs page-out

Do not merge:

- request-time reduction
- canonical eviction

into one undifferentiated "context management" bucket at the file level.

They operate on different objects and different time horizons.

### Page-in vs request preprocessing

Archive lookup and recovery may be triggered by reduction or eviction, but
page-in is its own concern. Do not bury rehydration helpers inside request-time
reduction files.

### Integration layer vs domain logic

`index.ts`, provider wiring, and hook registration should stay thin. New
history/reduction/recovery logic should not grow back into runtime glue files.

## Validation Expectations Before Physical Moves

Before any physical regroup beyond facades, rerun at least:

1. plugin typecheck
2. plugin build
3. baseline continual smoke
4. plugin continual smoke
5. one benchmark path that exercises `new_session`

Until that validation is cheap and stable again, semantic regroup should remain
mostly design-level plus facade-level.
