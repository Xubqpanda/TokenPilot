# Multi-Runtime Adapter Plan

## Goal

The project should support multiple host runtimes without cloning the whole
plugin implementation for each one.

Target hosts include:

- OpenClaw
- Hermes Agent
- OpenJiuwen

The core rule is:

- `packages/openclaw-plugin/src` should contain OpenClaw-specific adapter logic
- `packages/layers/*` should contain runtime-agnostic method logic

## Desired split

### Runtime-agnostic layers

These modules should operate on neutral data structures and decision outputs.
They should not depend on OpenClaw hook names, provider registration, session
store layout, or transcript file formats.

Examples:

- decision policy
- history/canonical data model
- task-state estimation
- page-out candidate selection
- future semantic retrieval planning

### Runtime adapters

Each host runtime should have a dedicated adapter that translates host-native
objects and events into the neutral layer contracts.

Current adapter:

- `packages/openclaw-plugin/`

Future adapters may look like:

- `packages/hermes-adapter/`
- `packages/openjiuwen-adapter/`

## What must stay in the OpenClaw adapter

The following responsibilities are host-specific and should remain in the
OpenClaw adapter layer.

### Hook and lifecycle wiring

- plugin bootstrap
- hook registration
- context engine registration
- provider registration
- tool registration

### OpenClaw request/response transport details

- local `/v1/responses` proxy runtime
- provider mirroring under `ecoclaw/*`
- upstream probing / fetch fallback / curl fallback
- OpenClaw response payload patching

### OpenClaw session and transcript details

- OpenClaw session-id extraction
- OpenClaw session-key to session-id binding
- transcript JSONL loading/salvage for OpenClaw agents
- current OpenClaw state directory layout

### OpenClaw protocol markers and compatibility surface

- `ecoclaw` plugin id
- `ecoclaw-context`
- `ecoclaw/*`
- `ECOCLAW_*`
- recovery/payload markers already in live runtime traffic

## What should gradually move toward runtime-agnostic layers

These areas are currently implemented inside the OpenClaw plugin but are good
candidates for later extraction.

### Request/page-out/page-in algorithmic logic

- reduction pass orchestration
- reduction atomic passes
- archive recovery planning
- page-out candidate selection helpers
- task-state estimation helpers

### Neutral data models and plans

- transcript turn schema
- context rewrite plan
- page-out decision
- page-in request/result
- trace record schema

## Recommended migration strategy

### Phase 1: Keep current adapter split

Keep `packages/openclaw-plugin/src` as the active OpenClaw adapter while the
method continues to evolve.

### Phase 2: Introduce runtime-neutral contracts

Define a small set of host-neutral types before extracting more logic.

Suggested initial contracts:

- `RuntimeMessage`
- `RuntimeToolResult`
- `RuntimeSessionRef`
- `TranscriptTurn`
- `ContextRewritePlan`
- `PageOutDecision`
- `PageInRequest`
- `PageInResult`

### Phase 3: Extract pure logic

Move logic that only consumes neutral contracts out of the OpenClaw adapter and
into `packages/layers/*` or a shared runtime-neutral package.

Recommended extraction order:

1. reduction pass orchestration
2. archive recovery planning
3. task-state estimation helpers
4. trace record schemas

### Phase 4: Validate with a second adapter

Do not assume the boundary is good until a second adapter exists.
A Hermes or OpenJiuwen adapter is the real validation step.

## Current rule of thumb

When deciding where new code belongs:

- if it knows OpenClaw hook names, plugin APIs, provider registration, session
  store layout, or transcript file layout, keep it in the OpenClaw adapter
- if it only needs structured inputs and produces structured outputs, prefer
  putting it in a runtime-agnostic layer
