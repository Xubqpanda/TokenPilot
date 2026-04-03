# EcoClaw Architecture (L1)

## Core Goal

L1 focuses on deterministic, data-driven runtime decisions:

- No LLM-based policy decisions.
- Decisions must be explainable from observed evidence.
- Every turn should be traceable by API family (`openai-responses`, `openai-completions`, `anthropic-messages`, `other`).

## Layered Modules

Physical package layout now mirrors the semantic layers:

- `packages/layers/context`
- `packages/layers/decision`
- `packages/layers/execution`
- `packages/layers/orchestration`

### Context Layer

- `module-context-state`: lightweight current-session context state placeholder.
- `module-retrieval`: reserved boundary for future retrieval wiring; currently a light metadata placeholder.
- Future direction: build editable session/branch/message views from immutable storage.

### Decision Layer

- `module-policy`: static thresholds and rules (TTL, jitter, probe, summary trigger, compaction trigger).
- `module-task-router`: deterministic route/tier selection with confidence; currently used in bench/demo hosts, not the production plugin path.
- `module-decision-ledger`: records per-turn decision/evidence/outcome/ROI.

### Execution Layer

- `module-stabilizer`: prefix stabilization, candidate evaluation, and cache-tree registration.
- `module-summary`: builds handoff summary artifacts when requested by policy.
- `module-compaction`: converts a summary artifact into a concrete compaction plan.
- `module-reduction`: response/tool-content reduction and pruning for budget control.

### Orchestration Layer

- `layer-orchestration`: OpenClaw logical/physical session routing, draft materialization, optional provider-specific fork/replay, persistence writes.

### Observability (cross-cutting, not a standalone package)

- Kernel runtime events (`ecoclawEvents`) and trace (`ecoclawTrace`).
- Event trace JSONL and session `turns.jsonl` persisted to filesystem.

## API-Family-Aware Runtime

All turn contexts are normalized to an `apiFamily` before scheduling/execution.
Policy and router can branch behavior by family, for example:

- `openai-responses`: prefer incremental cache-aware policies.
- `openai-completions`: treat missing `cacheRead` as unknown signal (not forced miss).

## OpenClaw Plugin Runtime Path

Current production path is OpenClaw plugin first:

1. Plugin starts an embedded responses proxy (`ecoclaw/*` provider family).
2. For `openai-responses`, plugin can apply response root-link
   (`previous_response_id` injection) on matched stable prefixes.
3. Shadow pipeline still runs for deterministic decision traces
   (policy/cache/probe/compaction/summarization signals).
4. Runtime events are persisted and visualized via the lab dashboard.

Current plugin runtime intentionally stays minimal:

- enabled by default: `stabilizer`, `reduction`, `decision-ledger`
- not yet wired into production plugin path: `summary`, `compaction`, `memory-state`, `task-router`, `retrieval`

This keeps provider-routing behavior inside plugin deployment scope
without requiring OpenClaw core source patches.

## Persistence

EcoClaw persistence (filesystem-first):

- `<stateDir>/ecoclaw/sessions/<sessionId>/turns.jsonl`
- `<stateDir>/ecoclaw/sessions/<sessionId>/branches.jsonl`
- `<stateDir>/ecoclaw/sessions/<sessionId>/messages.jsonl`
- `<stateDir>/ecoclaw/sessions/<sessionId>/meta.json`
- `<stateDir>/ecoclaw/sessions/<sessionId>/summary.json` (legacy transitional path)

`stateDir` comes from connector host runtime (OpenClaw plugin config).

## Next Milestones

- L1.1: task-router + policy decision replay for offline tuning.
- L1.2: orchestration-side compaction execution refinements on top of the new plan boundary.
- L2+: learned/dynamic policies (optional, gated by offline metrics quality).
