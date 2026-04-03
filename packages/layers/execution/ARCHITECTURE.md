# Execution Layer Boundaries

The execution layer only produces transform artifacts. It does not mutate session topology.

## Module Responsibilities

- `stabilizer`
  - Normalizes and fingerprints stable prefixes for cache health observation.
  - Does not fork, replay, or rewrite upstream history.
- `reduction`
  - Applies local token-saving transforms to existing content.
  - Examples: tool payload trimming, format slimming, semantic compression.
- `summary`
  - Generates a summary for an explicitly chosen range of conversation blocks.
  - Returns summary text plus generation metadata.
  - Does not decide scope and does not apply the summary.
- `compaction`
  - Produces a checkpoint-style compaction seed and a compaction plan artifact.
  - The plan is only a description of what should be applied later.
  - It does not fork or seed sessions by itself.
- `handoff`
  - Produces a task handoff artifact for another model/sub-agent.
  - Does not route or spawn sub-agents by itself.

## Cross-Layer Contract

- `decision`
  - Chooses when an execution artifact is worth generating.
  - Chooses how an artifact should be applied.
- `orchestration`
  - Owns all session-topology actions:
    - fork
    - branch materialization
    - replay rebinding
    - upstream application
    - sub-agent context transfer

## Shared Semantic Generation

`summary`, `compaction`, and `handoff` share the `semantic` helper.

The helper supports three backends:

- `heuristic`: local deterministic text generation
- `llm_full_context`: sidecar model call over the provided blocks plus an instruction tail
- `prebuilt`: accept caller-supplied text directly

The caller owns block selection. The helper only turns those blocks into text.
