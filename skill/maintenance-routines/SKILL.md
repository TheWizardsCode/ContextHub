---
name: maintenance-routines
description: "Create and maintain the daily automated maintenance routines (/skill:test 07:00, /skill:standup 08:00, /skill/refactor 09:00 — daily, priority high) in the project's .worklog/scheduled-prompts.json. Non-destructive and idempotent. Trigger on: '/skill:maintenance-routines', 'maintenance routines', 'schedule the daily test/standup/refactor runs'"
---

# Maintenance-Routines Skill

## Purpose

Every project should run the same three automated maintenance routines every
day, dispatched at **high** request priority so they are served even during
peak periods:

| id | time | intervalDays | priority |
|---|---|---|---|
| `/skill:test` | `07:00` | 1 (daily) | `high` |
| `/skill:standup` | `08:00` | 1 (daily) | `high` |
| `/skill/refactor` | `09:00` | 1 (daily) | `high` |

They live in the project-local scheduled-prompts config consumed by the
herdr downtime worker (`.worklog/scheduled-prompts.json`, dispatched on idle —
see [packages/herdr/README.md](../../packages/herdr/README.md#scheduled-prompts)
and [docs/dev/downtime-dispatcher.md](../../docs/dev/downtime-dispatcher.md#request-priority-x-priority-on-dispatched-panes)).
This skill is the **single maintained definition** of that set: it creates the
missing routines, corrects drifted `intervalDays` / `time` / `priority`
values, and touches nothing else.

`priority: high` is threaded by herdr into `HERDR_REQUEST_PRIORITY`, which the
Worklog pi extension turns into the `X-Priority` provider request header — the
routines therefore skip the peak-period contention queue. An entry that should
be polite must declare `low`/`medium` explicitly (absent ⇒ `high`).

## Triggers

- `/skill:maintenance-routines`
- "maintenance routines", "schedule the daily test/standup/refactor runs",
  "keep the maintenance schedule up to date"

## Invocation

```bash
cd $(skill_path maintenance-routines)
python3 scripts/maintenance_routines.py            # reconcile, human report
python3 scripts/maintenance_routines.py --json     # machine-readable report
python3 scripts/maintenance_routines.py --dry-run  # show the plan, write nothing
python3 scripts/maintenance_routines.py --help     # all flags
```

`--root PATH` targets another project root (default: the current working
directory); `--worklog-dir PATH` targets an explicit worklog directory
(default: `<root>/.worklog`). The skill is `wl`-independent — it only reads
and writes `<worklog dir>/scheduled-prompts.json`.

Exit codes: `0` = reconciled / unchanged / would-reconcile, `1` = refused
(absent or malformed config).

## What it does (and does not) change

Owned per routine — corrected whenever they drift from the table above:

- `intervalDays` (must be `1`),
- `time` (`07:00` / `08:00` / `09:00`),
- `priority` (must be `high`),
- `prompt` — **only** when it is missing or blank (herdr would skip such an
  entry). A valid customised prompt (e.g. `/skill:test --scope full`) is
  operator intent and is preserved.

Never changed:

- `lastTriggeredAt` (runtime state — preserved verbatim),
- unknown fields on a required entry,
- every other entry (user-defined routines, disabled experiments, …),
- unrecognised raw list items,
- unknown root-level keys of the config file.

A routine whose entry is **absent** is appended in table order after the
existing entries; existing entry order is otherwise preserved. A second run
changes nothing (byte-identical file).

Writes are atomic: a unique temp file in the same directory followed by
`os.replace`, mirroring herdr's `saveScheduledPrompts` tmp+rename pattern, so
a reader never sees a partial config. An already-canonical config is not
written at all.

## Fail-closed behaviour

A **missing** or **malformed** config is refused with a clear report
(`reason`, `remedy`) and nothing is created or written — `wl init` is the
provisioning path. This also keeps the skill from inventing a `.worklog/`
directory in a directory that is not a Worklog project.

| `reason` | Meaning | Remedy |
|---|---|---|
| `config-missing` | No `scheduled-prompts.json` in the worklog dir | `wl init` (create-if-absent) provisions it, then re-run |
| `config-unreadable` | The file exists but cannot be read | Fix permissions, re-run |
| `config-malformed-json` | Corrupt JSON | Repair/restore the file, re-run |
| `config-not-an-object` | Root is not a JSON object | Repair/restore the file, re-run |
| `config-entries-not-a-list` | No `entries` list | Add an `entries` list (see the `wl init` template) |

## Report

`--json` emits one report object:

```json
{
  "success": true,
  "action": "reconciled",
  "config_path": "/project/.worklog/scheduled-prompts.json",
  "dry_run": false,
  "required": [{ "id": "/skill:test", "prompt": "/skill:test", "intervalDays": 1,
                 "time": "07:00", "priority": "high" }],
  "routines": [
    { "id": "/skill:test", "action": "updated",
      "changes": [{ "field": "priority", "from": "medium", "to": "high" }] }
  ],
  "changed": ["/skill:test"],
  "preserved_entry_ids": ["custom"],
  "entries_before": 1,
  "entries_after": 3,
  "reason": null,
  "remedy": null
}
```

`action` is one of `reconciled`, `unchanged`, `would-reconcile`, `refused`;
per-routine `action` is `created`, `updated` or `unchanged`.

## New projects and drift

`templates/scheduled-prompts.json` (the `wl init` base set) carries the same
three routines, so a freshly initialised project is already canonical and a
reconcile reports `unchanged` — a test pins that agreement
(`tests/skill/maintenance-routines/test_maintenance_routines_cli.py`), so the
template and this skill cannot silently drift apart. `wl init` itself stays
create-if-absent: existing configs are never clobbered; use this skill to
migrate them.

## Bootstrapping (optional)

Operators may schedule the reconciler itself so the schedule is self-healing,
e.g. add an entry with `id`/`prompt` `/skill:maintenance-routines` (any
interval/priority). This is **not** required and is **not** part of the
required set — the reconciler never adds, removes or rewrites it.

## Tests

```bash
# skill logic (reconcile, idempotence, preservation, refusals, dry-run)
python3 -m pytest skill/maintenance-routines/tests -q
# integration (real CLI against a throwaway project, template agreement)
python3 -m pytest tests/skill/maintenance-routines -q
```

## Implementation

- `scripts/maintenance_routines.py` — the reconciler (pure
  `reconcile_entries()` core + file-level `reconcile()` + CLI).
- `tests/test_maintenance_routines.py` — unit tests.
- `tests/skill/maintenance-routines/test_maintenance_routines_cli.py` —
  integration tests (repo-level test suite).
