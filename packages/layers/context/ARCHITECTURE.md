# Context Layer Boundaries

The context layer owns the working view of a session.

It does not own provider-specific fork/replay mechanics, and it does not own immutable persistence.

## Responsibilities

- Build the current editable session view from storage.
- Expose message/branch-oriented context state for UI, policy, and orchestration.
- Support message-level transforms as draft operations:
  - insert
  - replace
  - delete
  - reorder
- Treat summary / checkpoint seed / handoff as message artifacts, not out-of-band memory blobs.

## Non-Responsibilities

- No upstream API calls.
- No provider-specific `previous_response_id` / parent-id wiring.
- No physical fork execution.
- No immutable storage writes by itself.

## Cross-Layer Contract

- `storage`
  - Stores immutable session history:
    - sessions
    - branches
    - messages
    - turns
- `context`
  - Builds the current view from storage and draft edits.
- `execution`
  - Produces transform artifacts or candidate replacement messages.
- `decision`
  - Chooses whether a transform is worth applying.
- `orchestration`
  - Materializes edited views into new branches at the first divergence point.
  - Owns provider-specific branch/fork/replay behavior.
