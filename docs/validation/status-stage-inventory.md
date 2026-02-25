# Status/Stage Validation Rules Inventory

## Purpose
This document inventories all known status/stage validation rules, their sources,
and any gaps/ambiguities. It is intended to be the single reference for shared
validation helpers and UI wiring.

## Status and Stage Values
- Statuses (canonical): config defaults in .worklog/config.defaults.yaml
  - Source of truth: .worklog/config.defaults.yaml (statuses)
  - Type: src/types.ts
  - Current defaults:
    - open
    - in-progress
    - blocked
    - completed
    - deleted
- Stages (canonical): config defaults in .worklog/config.defaults.yaml
  - Source of truth: .worklog/config.defaults.yaml (stages)
  - Current defaults:
    - idea
    - intake_complete
    - plan_complete
    - in_progress
    - in_review
    - done
  - Defaulting behavior on create/import: idea for CLI create, blank stage on import
    - Source: src/commands/create.ts (CLI default), src/jsonl.ts (import default)

## Compatibility Rules (Explicit)
### Status -> Allowed Stages
Defined in config defaults.
- Source of truth: .worklog/config.defaults.yaml (statusStageCompatibility)
- Runtime loader: src/status-stage-rules.ts
- Current defaults:
  - open -> idea, intake_complete, plan_complete, in_progress
  - in-progress -> intake_complete, plan_complete, in_progress
  - blocked -> idea, intake_complete, plan_complete
  - completed -> in_review, done
  - deleted -> idea, intake_complete, plan_complete, done

### Stage -> Allowed Statuses
Derived at runtime from the compatibility mapping.
- Source of truth: .worklog/config.defaults.yaml (statusStageCompatibility)
- Runtime derivation: src/status-stage-rules.ts

### Update Dialog Validation
TUI update dialog rejects invalid status/stage combinations.
- Source: src/tui/update-dialog-submit.ts (buildUpdateDialogUpdates)
- Tests: tests/tui/tui-update-dialog.test.ts
  - Rejects invalid status/stage combinations.
  - Accepts compatible updates and applies changes.

### Close Dialog Status/Stage Mapping
Close dialog sets status/stage pairs as follows:
- Close (in_review) -> status=completed, stage=in_review
- Close (done) -> status=completed, stage=done
- Close (deleted) -> status=deleted, stage=''
- Source: src/status-stage-rules.ts (STATUS_STAGE_RULE_NOTES)
- UI options: src/tui/components/dialogs.ts

## Dependency Rules (Implied)
Adding/removing dependency edges affects status based on the dependency stage.
- On dep add: if dependsOn.stage not in [in_review, done], set item status=blocked
  - Source: src/commands/dep.ts (add)
- On dep remove: if no remaining deps with stage not in [in_review, done], set item status=open
  - Source: src/commands/dep.ts (rm)

## Selection/Filtering Rules (Implied)
The next-item selection logic treats in_review specially and filters statuses.
- Exclude status=blocked and stage=in_review by default (unless --include-in-review)
  - Source: src/commands/next.ts (option), src/database.ts (findNextWorkItemFromItems)
- Filter out status=deleted in next-item selection
  - Source: src/database.ts (findNextWorkItemFromItems)

## CLI/Docs References
- CLI docs should reference config defaults for status/stage values.
  - Source: CLI.md
- Workflow templates reference stages, not status/stage compatibility.
  - Source: templates/AGENTS.md, templates/WORKFLOW.md

## Gaps and Ambiguities
- Historical note: any hard-coded status/stage arrays in older docs or helpers are obsolete.
  - Current source of truth is .worklog/config.defaults.yaml and the loader in src/status-stage-rules.ts.
- CLI update/create paths do not enforce status/stage compatibility.
  - Observed: src/commands/update.ts allows any status/stage values.
  - Behavior: database stores values without validation.
- Stage value "blocked" appears in tests but is not in canonical stage list.
  - Observed: tests/tui/tui-update-dialog.test.ts uses stage='blocked' in Update Dialog Functions
  - Not present in .worklog/config.defaults.yaml stages list.
- Status default and stage default are set during create/import, but no validation
  is applied on update or import beyond missing-field normalization.

## Examples
- Valid: status=open, stage=idea
- Valid: status=in-progress, stage=in_progress
- Valid: status=completed, stage=in_review
- Invalid (TUI rejected): status=completed, stage=idea
- Invalid (TUI rejected): status=deleted, stage=in_review
