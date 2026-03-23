# EcoClaw Architecture (L1)

## Core Goal

L1 focuses on deterministic, data-driven runtime decisions:

- No LLM-based policy decisions.
- Decisions must be explainable from observed evidence.
- Every turn should be traceable by API family (`openai-responses`, `openai-completions`, `anthropic-messages`, `other`).

## Layered Modules

Physical package layout now mirrors the semantic layers:

- `packages/layers/data`
- `packages/layers/decision`
- `packages/layers/execution`
- `packages/layers/orchestration`

### Data Layer

- `module-memory-state`: short/medium-term session state snapshots.
- `module-retrieval`: retrieval hooks for task-relevant context.

### Decision Layer

- `module-policy`: static thresholds and rules (TTL, jitter, probe, summary trigger).
- `module-task-router`: deterministic route/tier selection with confidence.
- `module-decision-ledger`: records per-turn decision/evidence/outcome/ROI.

### Execution Layer

- `module-cache`: prefix-matching candidate evaluation + cache tree registration.
- `module-compaction-trigger`: static compaction recommendation trigger (responses-first).
- `module-summary`: builds summary artifacts when requested.
- `module-compression`: response/tool-content shaping for budget control.

### Orchestration Layer

- `layer-orchestration`: OpenClaw logical/physical session routing, optional policy-driven fork, persistence.

### Observability (cross-cutting)

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

This keeps provider-routing behavior inside plugin deployment scope
without requiring OpenClaw core source patches.

## Persistence

EcoClaw persistence (filesystem-first):

- `<stateDir>/ecoclaw/sessions/<sessionId>/turns.jsonl`
- `<stateDir>/ecoclaw/sessions/<sessionId>/meta.json`
- `<stateDir>/ecoclaw/sessions/<sessionId>/summary.json`

`stateDir` comes from connector host runtime (OpenClaw plugin config).

## Next Milestones

- L1.1: task-router + policy decision replay for offline tuning.
- L1.2: compaction module (separate from summary artifact generation).
- L2+: learned/dynamic policies (optional, gated by offline metrics quality).
