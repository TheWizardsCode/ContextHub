---
name: pane-triage
description: "Approval-gated close of idle panes in the current herdr workspace. Scans the invoking workspace, classifies each pane via the shared pane-close classifier, shows work-item context and log tails, and closes only panes the producer explicitly approves. Trigger on queries like: 'pane triage', 'pane-triage', 'close idle panes', 'triage panes'"
---

# Pane-Triage Skill

## Purpose

Approval-gated, workspace-scoped cleanup of idle herdr panes. This is the
**manual complement** to the automatic pane-close reaper
(`WL-0MUJW9EEP009Q0V3`): the reaper closes settled panes unattended, while
this skill lets a producer review idle panes (with work-item context and a
log tail) and close a chosen subset.

**Never closes anything without explicit producer approval.** The
never-close guards (implement panes, `needsProducerReview=true` items, the
invoking pane, and panes with live child processes) apply universally — to
both this skill and the automatic reaper.

## Triggers

- `/skill:pane-triage`
- "pane triage", "pane-triage", "close idle panes", "triage panes"

## Invocation

```bash
cd $(skill_path pane-triage)
./scripts/pane-triage.py            # report, then prompt for approval
./scripts/pane-triage.py --dry-run  # report only, never close
./scripts/pane-triage.py --json     # machine-readable report
```

When invoked via `/skill:pane-triage` from the Pi chat, the agent runs the
script and relays the report, then asks the producer for approval.

## Shared Classifier (do not reimplement)

Idle state is **never** derived in this skill. Classification is delegated to
the shared classifier in ContextHub (`packages/herdr/src/pane-close.ts`),
reached through the compiled bridge CLI
(`packages/herdr/dist/pane-close-cli.js --json`). The bridge imports
`classifySession` / `extractFinalAssistantText` verbatim and emits one JSON
record per pane:

```json
{
  "panes": [
    {
      "paneId": "w2V:p7B",
      "paneTitle": "Downtime triggered implement Foo - WL-0ABC123",
      "itemId": "WL-0ABC123",
      "workspaceId": "w2V",
      "tabId": "w2V:t1X",
      "kind": "implement",
      "close": false,
      "reasonCode": "implement",
      "reasonSnapshot": { "needsProducerReview": false, "isInvokingPane": false },
      "success": true
    }
  ],
  "evaluated": 1,
  "closeCount": 0,
  "failureCount": 0,
  "dryRun": true
}
```

`close: true` means the shared classifier judged the pane idle
(`reasonCode: "marker"` or `"idle-threshold"`); every other `reasonCode`
(`implement`, `producer-review`, `invoking-pane`, `live-children`,
`dead-agent`, `active`, `grace-period`) means the pane must stay open.

## Workflow

1. **Resolve workspace (AC1).** Read `HERDR_WORKSPACE_ID`; if absent, fall
   back to `herdr pane current` → `result.pane.workspace_id`. Only the
   invoking workspace is reported — no cross-workspace roll-up.
2. **Classify (AC2).** Shell out to the shared bridge with
   `--json --dry-run --workspace <id>`. Fail closed on any bridge error.
3. **Report (AC3).** Render `## Idle` and `## Active` tables (pane id, tab,
   title, work-item id, `needsProducerReview`, reason).
4. **Log tails (AC4).** For each idle pane, print the last 20 log lines under
   the heading `<pane title> Needs Review <true|false>`.
5. **Recommend (AC5).** Build the "Recommended to close" table, excluding the
   invoking pane (`HERDR_PANE_ID`) and any pane with `needsProducerReview=true`.
6. **Approve (AC6).** Prompt `yes` / `select N,M` / `no`. Ambiguity or `no`
   closes nothing. The invoking pane is never closed.
7. **Re-verify and close (AC7).** Immediately before closing, re-read the pane
   list through the bridge and drop any pane that is no longer idle; close the
   remainder one at a time and record a per-pane ledger.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/pane_triage.py` | Core logic — workspace resolution, bridge parsing, report, recommendation, approval parsing, re-verify-before-close |
| `scripts/pane-triage.py` | CLI wrapper — argv parsing, interactive prompt, log-tail fetching, herdr close calls |

## Bridge Configuration

The bridge path defaults to
`${CONTEXTHUB_DIR:-~/projects/ContextHub}/packages/herdr/dist/pane-close-cli.js`
and can be overridden with the `PANE_TRIAGE_BRIDGE` environment variable.
Build the bridge with:

```bash
cd "${CONTEXTHUB_DIR:-$HOME/projects/ContextHub}/packages/herdr" && npm run build
```

## Environment Variables

| Variable | Purpose |
|---|---|
| `HERDR_WORKSPACE_ID` | Invoking workspace id (preferred; falls back to `herdr pane current`) |
| `HERDR_PANE_ID` / `HERDR_PANE` | The invoking pane — never closed |
| `CONTEXTHUB_DIR` | ContextHub checkout root for the bridge path |
| `PANE_TRIAGE_BRIDGE` | Explicit bridge CLI path (overrides `CONTEXTHUB_DIR`) |

## Constraints

- **Shared classifier is mandatory** — classification is delegated to
  `classifySession` via the bridge; no idle-state logic lives in this skill.
- **Shared reaper for closure** — the bridge uses `createHerdrReaperDeps` and
  `runReaper` for pane enumeration and classification.
- **Never-close guards** (universal): `implement` panes,
  `needsProducerReview=true` items, the invoking pane, and panes with live
  child processes.
- **Approval gate is mandatory** — nothing is closed unattended.
- **Workspace-scoped only** — no cross-workspace roll-up.
- **Fail-closed** — a bridge/`herdr` error reports and exits non-zero without
  any mutation.

## Tests

```bash
cd $(skill_path pane-triage)
python3 -m pytest tests/ -q
```

Offline fixture tests cover workspace resolution, classification mapping,
marker-mid-message rejection, work-item-id parsing, `needsProducerReview`
mapping, recommendation rules, and approval gating (no approval → zero close
calls).

## Related Work Items

- `WL-0MUJMXVPO0016DZM` — this skill
- `WL-0MUJW9EEP009Q0V3` — shared classifier + automatic reaper (dependency)
- `WL-0MUJL1NAH0042GOS` — why completed plan/intake sessions are not closed
