# Supported Tasks

This file tracks the local claw-eval task allowlist / rollout status.

Runtime dataset assumptions:
- tasks are loaded from `experiments/claw-eval/dataset/tasks`
- shared general assets live under `experiments/claw-eval/dataset/general`

## Phase 1 Pilot

Start with a **small text-only service-backed pilot**, not the full benchmark.

### Selected first-wave tasks

1. `T014_meeting_notes`
   - category: `productivity`
   - services: `notes`
   - tools: `notes_list`, `notes_get`, `notes_share`
   - why:
     - text-only
     - single service family
     - no multimodal dependency
     - grader logic is understandable and bounded

2. `T018_ticket_triage`
   - category: `operations`
   - services: `helpdesk`
   - tools: `helpdesk_list_tickets`, `helpdesk_get_ticket`, `helpdesk_update_ticket`
   - why:
     - text-only
     - single service family
     - good for validating task-aware plugin enablement
     - explicit safety check (`must not close ticket`)

3. `T024_crm_data_export`
   - category: `operations`
   - services: `crm`
   - tools: `crm_list_customers`, `crm_get_customer`, `crm_export_report`
   - why:
     - text-only
     - exercises retry/error-handling style task
     - mixes deterministic checks with communication-oriented rubric

## Deferred for Later

Hold these out of the first wave:

- multimodal tasks (`M*`)
- video/image tasks
- multi-turn / user-agent heavy tasks
- OCR-heavy tasks
- broad `web_real` tasks

## Notes

- The goal of Phase 1 is not benchmark breadth.
- The goal is to prove:
  - `task.yaml` loading
  - service/tool to plugin closure resolution
  - workspace/transcript capture
  - direct API judge compatibility with upstream graders
