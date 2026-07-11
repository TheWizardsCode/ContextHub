# Inventory: `--stage in_progress` Usage Across All Skill Files

> **Work Item**: Audit: Inventory all skill files for --stage in_progress usage (WL-0MQQIK8OU0052YD0)
> **Date**: 2026-06-24
> **Scope**: Skill files under `~/.pi/agent/skills/` and `AGENTS.md` files
> **Method**: grep-based discovery on all `.md`, `.py`, `.sh`, `.js`, `.mjs` files

---

## Canonical Reference: Status vs Stage (from `AGENTS.md`)

| Concept | Purpose | Values | When to set |
|---------|---------|--------|-------------|
| **`status`** | Operational state — whether someone is actively working on the item | `open`, `in_progress`, `completed`, `blocked`, `deleted` | At the start/end of any active work session |
| **`stage`** | Lifecycle phase — how far through the defined process the item has progressed | `idea`, `intake_complete`, `plan_complete`, `in_progress`, `in_review`, `done` | Only when the item transitions between lifecycle phases |

The global `AGENTS.md` (line 21) uses **status-only** for claiming:
```
wl update <id> --status in_progress --assignee <your-agent-name>
```

Setting `--stage in_progress` should only occur when the item is entering the **implementation phase** of its lifecycle. Using it as a temporary "actively working" signal during intake or planning conflates the two dimensions.

---

## Summary Table

| Skill | SKILL.md (docs) | Scripts (implementation) | Documentation-Match? | Stage-semantic correctness |
|-------|-----------------|--------------------------|---------------------|---------------------------|
| **implement** | `--status in_progress --stage in_progress` (Claim) | N/A (no scripts) | ✅ N/A | ✅ Correct — entering implementation phase |
| **implement-single** | `--status in_progress --stage in_progress` (Claim) | N/A (no scripts) | ✅ N/A | ✅ Correct — entering implementation phase |
| **implementall** | `--status in_progress` (status-only in docs) | `--status in_progress --stage in_progress` (dual-set) | ❌ Docs say status-only, code dual-sets | ✅ Correct — dual-set is right for implementation; docs need updating |
| **planall** | `--status in_progress` (status-only in docs) | `--status in_progress --stage in_progress` (dual-set) | ❌ Docs say status-only, code dual-sets | ❌ Dual-set is wrong — planning is not implementation |
| **intakeall** | `--status in_progress --stage in_progress` (dual-set in docs) | `--status in_progress --stage in_progress` (dual-set) | ✅ Match | ❌ Dual-set is wrong — intake is not implementation |
| **audit** | `--status in_progress` (status-only) | `--status in_progress` (status-only) | ✅ Match | ✅ Correct — audit is a non-stage-modifying operation |
| **effort-and-risk** | `--status in_progress` (status-only) | N/A | ✅ N/A | ✅ Correct — non-stage-modifying |
| **find-related** | `--status in_progress` (status-only) | N/A | ✅ N/A | ✅ Correct — non-stage-modifying |
| **refactor** | `--status in_progress` (status-only) | N/A | ✅ N/A | ✅ Correct — non-stage-modifying |
| **ralph** | N/A (uses `in_progress` as valid entry stage) | Accepts `in_progress` as valid entry stage for loop | ✅ N/A | ✅ Correct — Ralph resumes implementations already in `in_progress` stage |

---

## Detailed Occurrences

### Group A — Dual-set (`--status in_progress --stage in_progress`)

These skills set BOTH status and stage to `in_progress` when claiming a work item. The semantic question is whether the stage transition is appropriate for the operation being performed.

#### 1. implement/SKILL.md

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/implement/SKILL.md` |
| **Lines** | 84 (Step 0), 122 (Step 1 Claim), 170 (Blocker claim), 293-294 (Status Transition Matrix) |
| **Step 0** (line 84) | `wl update <work-item-id> --status in_progress --json` — **status-only** ✅ |
| **Step 1 Claim** (line 122) | `wl update <work-item-id> --status in_progress --stage in_progress --assignee "<AGENT>" --json` — **dual-set** |
| **Circumstance** | Agent claims a work item for implementation (Step 1 of the implement workflow) |
| **Semantic signal** | The item is entering the **implementation lifecycle phase** — `stage=in_progress` is the correct stage for this transition. |
| **Assessment** | ✅ **Correct** — The item is moving from `plan_complete` (or similar) into the implementation phase. Dual-set is appropriate here. The Step 0 status-only is also correct as a lighter-weight "active" signal before the full claim. |

#### 2. implement-single/SKILL.md

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/implement-single/SKILL.md` |
| **Lines** | 84 (Step 0), 120 (Step 1), 184-185 (Status Transition Matrix) |
| **Step 1** (line 120) | `wl update <work-item-id> --status in_progress --stage in_progress --assignee "<AGENT>" --json` — **dual-set** |
| **Circumstance** | Same pattern as `implement` — claiming for implementation |
| **Assessment** | ✅ **Correct** — Same rationale as implement. Item enters implementation phase. |

#### 3. implementall/scripts/implementall.py

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/implementall/scripts/implementall.py` |
| **Lines** | 159-160 (inside `_invoke_implement()`) |
| **Code** | `"--status", "in_progress", "--stage", "in_progress",` |
| **Circumstance** | Claiming items for batch implementation in the ImplementAll engine |
| **Semantic signal** | Item is entering the implementation phase |
| **Assessment** | ✅ **Correct** — The dual-set is semantically appropriate for implementation. |
| **⚠ Documentation mismatch** | `implementall/SKILL.md` (line 13) documents status-only: `wl update <id> --status in_progress`. The implementation correctly uses dual-set, but the documentation needs updating to match. |

#### 4. planall/scripts/planall.py

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/planall/scripts/planall.py` |
| **Lines** | 151-152 (inside `_invoke_plan()`) |
| **Code** | `"--status", "in_progress", "--stage", "in_progress",` |
| **Circumstance** | Claiming items for batch PLANNING (not implementation) |
| **Semantic signal** | Despite being a planning operation, the implementation sets `stage=in_progress`. The item is typically in `intake_complete` stage before planning. |
| **Assessment** | ❌ **Incorrect** — Planning is NOT the implementation phase. The dual-set conflates `stage` lifecycle phases. Should be **status-only** (`--status in_progress`), matching the documentation in `planall/SKILL.md`. The item's stage should remain `intake_complete` during planning; the plan operation will advance it to `plan_complete`. |
| **Recovery pattern** | On failure, the recovery action is `--status open --stage intake_complete`, which confirms the intended original stage was `intake_complete`. |
| **⚠ Documentation mismatch** | `planall/SKILL.md` (line 13) correctly documents status-only: `wl update <id> --status in_progress`. The implementation is out of sync with the docs. |

#### 5. intakeall/SKILL.md

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/intakeall/SKILL.md` |
| **Lines** | 16 |
| **Code** | `wl update <id> --status in_progress --stage in_progress` |
| **Circumstance** | Claiming items for batch INTAKE processing |
| **Semantic signal** | Item is entering INTAKE — an information-gathering phase that precedes planning |
| **Assessment** | ❌ **Incorrect** — Intake operates on items in `idea` stage. Setting `stage=in_progress` during intake conflates the lifecycle. Should be **status-only** (`--status in_progress`). After intake completes, the stage advances to `intake_complete`. |
| **Note** | The SKILL.md's flow description (line 12) correctly uses `--stage idea --json` for the discovery query, but the claim step (line 16) incorrectly uses dual-set. |

#### 6. intakeall/scripts/intakeall.py

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/intakeall/scripts/intakeall.py` |
| **Lines** | 281-282 (inside `_invoke_intake()`) |
| **Code** | `"--status", "in_progress", "--stage", "in_progress",` |
| **Circumstance** | Claiming items for intake processing (the `/intake` equivalent) |
| **Semantic signal** | Same as SKILL.md — intake is not implementation |
| **Assessment** | ❌ **Incorrect** — Same issue as SKILL.md. Should be status-only. However, the recovery fallback (line ~380+) correctly resets to `--stage idea --status open`, confirming the expected original stage was `idea`. |
| **Note on auto_complete** | The `auto_complete()` method (line ~183) correctly uses **status-only** for claiming (`--status in_progress --json`) before advancing to `intake_complete`. This is the correct pattern — claim with status-only, then transition stage independently. The `_invoke_intake()` method should follow the same convention. |

---

### Group B — Status-only (`--status in_progress`)

These skills correctly use only the `--status` flag when claiming an item, keeping the `stage` unchanged. This is the canonical pattern for non-stage-modifying operations.

#### 7. audit/scripts/audit_runner.py

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/audit/scripts/audit_runner.py` |
| **Line** | 1372 |
| **Code** | `_run_wl(runner, ["wl", "update", issue_id, "--status", "in_progress", "--json"])` |
| **Circumstance** | Start of audit execution |
| **Assessment** | ✅ **Correct** — Audit is a non-stage-modifying operation. Status-only is the canonical pattern. |

#### 8. audit/SKILL.md

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/audit/SKILL.md` |
| **Lines** | 59, 62 |
| **Code** | `wl update <id> --status in_progress --json` |
| **Circumstance** | Start of audit (documentation) |
| **Assessment** | ✅ **Correct** — Matches the implementation. |

#### 9. effort-and-risk/SKILL.md

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/effort-and-risk/SKILL.md` |
| **Line** | 20 |
| **Code** | `wl update <issue-id> --status in_progress --json` |
| **Circumstance** | Start of effort/risk estimation |
| **Assessment** | ✅ **Correct** — Non-stage-modifying. |

#### 10. find-related/SKILL.md

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/find-related/SKILL.md` |
| **Lines** | 35-36 |
| **Code** | `wl update <id> --status in_progress --json` |
| **Circumstance** | Start of finding related work |
| **Assessment** | ✅ **Correct** — Non-stage-modifying. |

#### 11. refactor/SKILL.md

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/refactor/SKILL.md` |
| **Lines** | 54-55 |
| **Code** | `wl update <id> --status in_progress --json` |
| **Circumstance** | Start of refactor operation |
| **Assessment** | ✅ **Correct** — Non-stage-modifying. |

---

### Group C — Stage/Semantic References (no direct `--stage` flag set)

These files reference `in_progress` stage as a concept or precondition check rather than setting it via the CLI.

#### 12. ralph/scripts/ralph_loop.py

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/ralph/scripts/ralph_loop.py` |
| **Lines** | 2638, 2641 |
| **Code** | `if stage not in {"plan_complete", "in_review", "intake_complete", "in_progress"}:` |
| **Circumstance** | Precondition check — validates that the target item is in an acceptable stage before starting the Ralph loop |
| **Assessment** | ✅ **Correct** — Accepting `in_progress` as a valid entry stage is intentional. It allows Ralph to resume/continue an already-started implement→audit loop (e.g., after a crash or manual interrupt). The error message also documents this: "Target must be stage plan_complete, in_review, or in_progress (or intake_complete for auto-plan)". |

#### 13. audit/SKILL.md (stage references in closure logic)

| Field | Value |
|-------|-------|
| **File** | `~/.pi/agent/skills/audit/SKILL.md` |
| **Lines** | 156, 316, 318 |
| **Context** | Documents that children with `status: in_progress` but `stage: in_review` are acceptable and do NOT block closure. |
| **Assessment** | ✅ **Correct** — These are logical references to the valid state transition where an item is actively being worked on (status=in_progress) during its in_review phase. This is an intentional and valid combination. |

---

## Inconsistencies and Recommendations

### Inconsistency 1: planall — docs say status-only, code does dual-set

| Detail | Value |
|--------|-------|
| **Files** | `planall/SKILL.md` (doc) vs `planall/scripts/planall.py` (impl) |
| **Doc says** | `wl update <id> --status in_progress` |
| **Code does** | `"--status", "in_progress", "--stage", "in_progress",` |
| **Severity** | Medium — code is wrong; stage should not be set during planning |
| **Recommendation** | **Fix the implementation** (`planall.py` lines 151-152): Change dual-set to status-only to match the canonical documentation. The planning phase should not advance the stage to `in_progress`. |

### Inconsistency 2: implementall — docs say status-only, code does dual-set (correctly)

| Detail | Value |
|--------|-------|
| **Files** | `implementall/SKILL.md` (doc) vs `implementall/scripts/implementall.py` (impl) |
| **Doc says** | `wl update <id> --status in_progress` |
| **Code does** | `"--status", "in_progress", "--stage", "in_progress",` |
| **Severity** | Low — the code is semantically correct; the documentation needs updating |
| **Recommendation** | **Update the documentation** (`implementall/SKILL.md` line 13): Change to `wl update <id> --status in_progress --stage in_progress` to match the implementation, since implementation is the correct lifecycle phase for `stage=in_progress`. |

### Inconsistency 3: intakeall — dual-set is semantically wrong in both docs and code

| Detail | Value |
|--------|-------|
| **Files** | `intakeall/SKILL.md` (doc) and `intakeall/scripts/intakeall.py` (impl) |
| **Both say** | `--status in_progress --stage in_progress` |
| **Severity** | High — the stage transition is semantically incorrect; intake is not implementation |
| **Recommendation** | **Fix both documentation and implementation**: Change `_invoke_intake()` in `intakeall.py` (lines 281-282) and `intakeall/SKILL.md` (line 16) to use status-only (`--status in_progress`). The `auto_complete()` method already follows the correct pattern (status-only claim then stage transition) and should serve as the reference. |

### Inconsistency 4: planall recovery pattern confirms wrong stage

| Detail | Value |
|--------|-------|
| **File** | `planall/scripts/planall.py` line 237-248 |
| **Context** | On error, recovery resets to `--status open --stage intake_complete` |
| **Issue** | The recovery assumes the item should be at `intake_complete` stage, confirming that `stage=in_progress` was never the correct stage for planning |
| **Recommendation** | Same as Inconsistency 1 — fix the claim to use status-only. The recovery pattern already acknowledges the correct stage (`intake_complete`). |

### Inconsistency 5: intakeall recovery fallback resets to `idea` stage

| Detail | Value |
|--------|-------|
| **File** | `intakeall/scripts/intakeall.py` lines 373-410 (fallback branch) |
| **Context** | The `_attempt_recovery` fallback (for unknown/corrupted status) resets to `--stage idea --status open` |
| **Issue** | The fallback assumes the item's original stage was `idea`, confirming that `stage=in_progress` was never the correct stage during intake processing |
| **Recommendation** | Same as Inconsistency 3 — fix the claim to use status-only. The recovery pattern already acknowledges `idea` as the correct stage. |

---

## Correct Patterns (for reference)

### Pattern A — Status-only claim (for non-stage-modifying operations)

```bash
wl update <id> --status in_progress --json
```

**Use when**: The operation does NOT advance the item's lifecycle stage (audit, effort/risk estimation, find-related, refactor, intake claim, planning claim).

### Pattern B — Dual-set claim (for entering the implementation phase)

```bash
wl update <id> --status in_progress --stage in_progress --json
```

**Use when**: The item is entering the implementation lifecycle phase (implement, implement-single, implementall).

### Pattern C — Auto-complete pattern (intake)

```bash
# Claim with status-only
wl update <id> --status in_progress --json

# ... do the intake work ...

# Advance stage independently
wl update <id> --stage intake_complete --status open --json
```

**Use when**: A batch engine needs to claim an item, perform work, then transition the stage independently. The `intakeall.py` `auto_complete()` method demonstrates this correctly.

---

## Stage Lifecycle Flow (Canonical)

```
                         status=in_progress
                              |
idea --> intake_complete --> plan_complete --> in_progress --> in_review --> done
  |            |                  |                |               |          |
  |          intake             plan           implement        review     complete
  |                                                                          
  └── status=in_progress (temporary, reset to open after)
```

The `--status in_progress` flag is used as a temporary "actively working" signal during any phase. The `--stage in_progress` flag should ONLY be used when transitioning into the implementation phase.

---

## Cross-references

- This inventory builds on the existing `docs/validation/status-stage-inventory.md` which documents the underlying status/stage compatibility rules.
- Related work item: WL-0MQPS28DW008QFL3 — "Add wl doctor stage-sync command to fix stale stage/status combinations"
- Related work item: WL-0MQ53H78W000DQ08 — "Refactor colour mappings: remove status-based colours, use stage progression with blocked override"
- Related work item: WL-0MQJGBSUS0057EI4 — "Add ready_to_merge stage support to workflow config"
