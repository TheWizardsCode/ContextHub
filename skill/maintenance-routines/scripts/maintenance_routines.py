#!/usr/bin/env python3
# <!-- REFACTOR-WL-0MW34DD93007Q2U3
# smell: formatting
# severity: low
# description: Shebang is present but file is not executable
# -->
"""
Maintenance-routines reconciler (skill `/skill:maintenance-routines`).

Creates and maintains the canonical set of daily automated maintenance
sessions in a project's `.worklog/scheduled-prompts.json` — the config the
herdr downtime worker reads to dispatch scheduled prompts on idle
(WL-0MSS1Q5ER007QDKX). The three required routines are:

    /skill:test      07:00  daily  priority high
    /skill:standup   08:00  daily  priority high
    /skill:refactor  09:00  daily  priority high

`priority: high` is threaded by herdr into `HERDR_REQUEST_PRIORITY` (and
therefore the `X-Priority` provider request header), so the maintenance
sessions are served even during peak periods
(WL-0MVIDWJ090090J3Q AC3).

Semantics (AC1/AC2):

  * a required routine whose entry is ABSENT is created (appended in
    required order after the existing entries),
  * a required routine whose entry has DRIFTED `intervalDays` / `time` /
    `priority` is corrected; a missing/blank `prompt` is repaired to the
    command itself, while a valid customised prompt is preserved,
  * `lastTriggeredAt`, every unknown field, every foreign entry (and every
    unrecognised raw list item) and every unknown root-level key are
    preserved verbatim,
  * an already-canonical config is written not at all (byte-identical on a
    second run),
  * an ABSENT or MALFORMED config is refused fail-closed with a clear report
    (never created, never repaired silently) — `wl init` is the provisioning
    path,
  * `--dry-run` reports the planned diff and writes nothing,
  * writes are atomic (unique tmp file in the same directory + `os.replace`),
    mirroring herdr's `saveScheduledPrompts` tmp+rename pattern.

The skill is deliberately `wl`-independent: it only reads and writes
`<worklog dir>/scheduled-prompts.json`.

Usage:

    python3 scripts/maintenance_routines.py [--root PATH]
                                            [--worklog-dir PATH]
                                            [--dry-run] [--json]

Exit codes: 0 = reconciled / unchanged / would-reconcile, 1 = refused
(absent or malformed config), 2 = unusable arguments.
"""

import argparse
import json
import os
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

#: File name of the scheduled-prompts config inside the worklog directory.
SCHEDULED_PROMPTS_FILENAME = "scheduled-prompts.json"

#: Worklog directory name (a bare `.worklog` next to the project root).
WORKLOG_DIRNAME = ".worklog"

#: The priority alphabet herdr validates (`low|medium|high|critical`).
VALID_PRIORITIES = ("low", "medium", "high", "critical")

#: Default dispatch priority for a scheduled prompt (herdr default is `high`).
DEFAULT_PRIORITY = "high"

#: The canonical daily maintenance routines, in dispatch (time) order.
#: Keys mirror the on-disk camelCase schema consumed by herdr.
REQUIRED_ROUTINES: tuple[dict[str, Any], ...] = (
    {
        "id": "/skill:test",
        "prompt": "/skill:test",
        "intervalDays": 1,
        "time": "07:00",
        "priority": "high",
    },
    {
        "id": "/skill:standup",
        "prompt": "/skill:standup",
        "intervalDays": 1,
        "time": "08:00",
        "priority": "high",
    },
    {
        "id": "/skill:refactor",
        "prompt": "/skill:refactor",
        "intervalDays": 1,
        "time": "09:00",
        "priority": "high",
    },
)

#: Entry fields the reconciler owns — corrected when they drift (AC2).
DRIFT_FIELDS = ("intervalDays", "time", "priority")


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------


def resolve_config_path(
    root: Path | None = None,
    worklog_dir: Path | None = None,
) -> Path:
    """Resolve `<worklog dir>/scheduled-prompts.json`.

    Args:
        root: Project root (defaults to the current working directory); the
            config lives in its `.worklog/` subdirectory.
        worklog_dir: Explicit worklog directory, overriding *root*.

    Returns:
        The config file path (not necessarily existing).
    """
    if worklog_dir is not None:
        return Path(worklog_dir) / SCHEDULED_PROMPTS_FILENAME
    return Path(root or Path.cwd()) / WORKLOG_DIRNAME / SCHEDULED_PROMPTS_FILENAME


# ---------------------------------------------------------------------------
# Pure reconcile (no I/O)
# ---------------------------------------------------------------------------


def reconcile_entries(
    entries: Sequence[Any],
    required: Sequence[dict[str, Any]] = REQUIRED_ROUTINES,
) -> tuple[list[Any], list[dict[str, Any]]]:
    """Reconcile *entries* against the required routines.

    Pure and non-destructive: the input sequence is never mutated and every
    entry that is not a required routine is carried over unchanged.

    Args:
        entries: The raw `entries` list from the config file.
        required: The required-routine specs (defaults to REQUIRED_ROUTINES).

    Returns:
        A `(new_entries, changes)` tuple. `changes` holds one record per
        required routine — `{"id", "action", "changes"}` where `action` is
        `created` / `updated` / `unchanged` and `changes` lists the corrected
        fields as `{"field", "from", "to"}`.
    """
    result: list[Any] = [dict(entry) if isinstance(entry, dict) else entry for entry in entries]
    changes: list[dict[str, Any]] = []

    for spec in required:
        index = _find_entry_index(result, spec["id"])
        if index is None:
            result.append(_new_entry(spec))
            changes.append({"id": spec["id"], "action": "created", "changes": []})
            continue

        entry = result[index]
        field_changes: list[dict[str, Any]] = []
        for field in DRIFT_FIELDS:
            current = entry.get(field)
            wanted = spec[field]
            if current != wanted:
                entry[field] = wanted
                field_changes.append({"field": field, "from": current, "to": wanted})

        # The prompt is only repaired when it is missing/blank (herdr would
        # skip such an entry); a valid customised prompt is operator intent.
        prompt = entry.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            entry["prompt"] = spec["prompt"]
            field_changes.append(
                {"field": "prompt", "from": prompt, "to": spec["prompt"]}
            )

        changes.append(
            {
                "id": spec["id"],
                "action": "updated" if field_changes else "unchanged",
                "changes": field_changes,
            }
        )

    return result, changes


def _find_entry_index(entries: Sequence[Any], entry_id: str) -> int | None:
    """Return the index of the first dict entry whose `id` equals *entry_id*."""
    for index, entry in enumerate(entries):
        if isinstance(entry, dict) and entry.get("id") == entry_id:
            return index
    return None


def _new_entry(spec: dict[str, Any]) -> dict[str, Any]:
    """Build a fresh config entry for *spec* (never run, canonical fields)."""
    return {
        "id": spec["id"],
        "prompt": spec["prompt"],
        "intervalDays": spec["intervalDays"],
        "time": spec["time"],
        "priority": spec["priority"],
        "lastTriggeredAt": None,
    }


# ---------------------------------------------------------------------------
# File-level reconcile
# ---------------------------------------------------------------------------


def reconcile(
    root: Path | None = None,
    worklog_dir: Path | None = None,
    dry_run: bool = False,
    required: Sequence[dict[str, Any]] = REQUIRED_ROUTINES,
) -> dict[str, Any]:
    """Reconcile the project's scheduled-prompts config.

    Fail-closed: an absent or malformed config is refused (nothing is created
    or written). Never raises for config-level problems.

    Args:
        root: Project root (defaults to the current working directory).
        worklog_dir: Explicit worklog directory, overriding *root*.
        dry_run: Report the plan without writing.
        required: The required-routine specs (defaults to REQUIRED_ROUTINES).

    Returns:
        A JSON-friendly report dict (see the module docstring / SKILL.md).
    """
    path = resolve_config_path(root=root, worklog_dir=worklog_dir)
    report: dict[str, Any] = {
        "success": False,
        "action": "refused",
        "config_path": str(path),
        "dry_run": bool(dry_run),
        "required": [dict(spec) for spec in required],
        "routines": [],
        "changed": [],
        "preserved_entry_ids": [],
        "entries_before": None,
        "entries_after": None,
        "reason": None,
        "remedy": None,
    }

    loaded = _load_root(path)
    if loaded["refusal"] is not None:
        report["reason"] = loaded["refusal"]
        report["remedy"] = loaded["remedy"]
        return report

    config = loaded["root"]
    raw_entries = config["entries"]
    new_entries, routines = reconcile_entries(raw_entries, required)

    changed = [routine["id"] for routine in routines if routine["action"] != "unchanged"]
    required_ids = {spec["id"] for spec in required}
    report.update(
        {
            "success": True,
            "routines": routines,
            "changed": changed,
            "preserved_entry_ids": [
                entry["id"]
                for entry in raw_entries
                if isinstance(entry, dict) and entry.get("id") not in required_ids
            ],
            "entries_before": len(raw_entries),
            "entries_after": len(new_entries),
        }
    )

    if not changed:
        report["action"] = "unchanged"
        return report

    config["entries"] = new_entries
    payload = json.dumps(config, indent=2) + "\n"

    if dry_run:
        report["action"] = "would-reconcile"
        return report

    try:
        _write_atomic(path, payload)
    except OSError as exc:  # pragma: no cover - exercised only on I/O failure
        report["success"] = False
        report["action"] = "refused"
        report["reason"] = "write-failed"
        report["remedy"] = f"Fix the write error for {path} and re-run: {exc}"
        return report

    report["action"] = "reconciled"
    return report


def _load_root(path: Path) -> dict[str, Any]:
    """Load the raw config root, or a fail-closed refusal.

    Returns a dict with `root` (the parsed config object) and `refusal` /
    `remedy` (`None` on success). Never raises.
    """
    provision_hint = (
        f"Run `wl init` to provision {path} (create-if-absent), then re-run "
        "the maintenance-routines skill."
    )
    if not path.exists():
        return {
            "root": None,
            "refusal": "config-missing",
            "remedy": provision_hint,
        }

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        return {
            "root": None,
            "refusal": "config-unreadable",
            "remedy": f"Make {path} readable and re-run: {exc}",
        }

    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        return {
            "root": None,
            "refusal": "config-malformed-json",
            "remedy": f"Fix the JSON in {path} (or restore it) and re-run: {exc}",
        }

    if not isinstance(parsed, dict):
        return {
            "root": None,
            "refusal": "config-not-an-object",
            "remedy": f"`{path}` must contain a JSON object with an `entries` "
            "list — fix or restore it, then re-run.",
        }

    entries = parsed.get("entries")
    if not isinstance(entries, list):
        return {
            "root": None,
            "refusal": "config-entries-not-a-list",
            "remedy": f"Add an `entries` list to `{path}` (see `wl init`'s "
            "template) and re-run.",
        }

    return {"root": parsed, "refusal": None, "remedy": None}


def _write_atomic(path: Path, payload: str) -> None:
    """Write *payload* to *path* atomically (unique tmp file + `os.replace`)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(
        f"{path.name}.tmp-{os.getpid()}-{time.time_ns()}"
    )
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Reporting / CLI
# ---------------------------------------------------------------------------


def render_report(report: dict[str, Any]) -> str:
    """Render *report* as human-readable text."""
    lines = [
        f"Maintenance routines — {report['config_path']}",
        "",
    ]

    if report["routines"]:
        width = max(len(spec["id"]) for spec in report["required"])
        for routine in report["routines"]:
            spec = next(s for s in report["required"] if s["id"] == routine["id"])
            detail = (
                f"{spec['time']} every {spec['intervalDays']}d "
                f"priority={spec['priority']}"
            )
            extra = ""
            if routine["changes"]:
                extra = " — " + ", ".join(
                    f"{change['field']} {change['from']!r} → {change['to']!r}"
                    for change in routine["changes"]
                )
            lines.append(
                f"  {routine['id']:<{width}}  {detail:<34} {routine['action']}{extra}"
            )
        lines.append("")

    if report["action"] == "refused":
        lines.append(f"REFUSED ({report['reason']}) — no change was made.")
        lines.append(f"Remedy: {report['remedy']}")
        return "\n".join(lines)

    preserved = report["preserved_entry_ids"]
    preserved_note = (
        f"{len(preserved)} other entr{'y' if len(preserved) == 1 else 'ies'} preserved"
        if preserved
        else "no other entries"
    )
    if report["action"] == "unchanged":
        lines.append(f"Schedule already up to date ({preserved_note}).")
    elif report["action"] == "would-reconcile":
        lines.append(
            f"Dry run — would update {len(report['changed'])} routine(s): "
            f"{', '.join(report['changed'])} ({preserved_note}). Nothing written."
        )
    else:
        lines.append(
            f"Reconciled {len(report['changed'])} routine(s): "
            f"{', '.join(report['changed'])} ({preserved_note})."
        )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point: reconcile and report. Returns the process exit code."""
    parser = argparse.ArgumentParser(
        prog="maintenance_routines.py",
        description=(
            "Create/maintain the daily maintenance routines (/skill:test 07:00, "
            "/skill:standup 08:00, /skill:refactor 09:00 — all priority high) in "
            "<worklog dir>/scheduled-prompts.json."
        ),
    )
    parser.add_argument(
        "--root",
        default=None,
        help="Project root (default: current working directory).",
    )
    parser.add_argument(
        "--worklog-dir",
        default=None,
        help="Worklog directory holding scheduled-prompts.json "
        "(default: <root>/.worklog).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report the planned changes without writing the config.",
    )
    parser.add_argument(
        "--json",
        dest="as_json",
        action="store_true",
        help="Emit the machine-readable report instead of text.",
    )
    args = parser.parse_args(argv)

    root = Path(args.root).resolve() if args.root else Path.cwd()
    worklog_dir = Path(args.worklog_dir).resolve() if args.worklog_dir else None

    report = reconcile(root=root, worklog_dir=worklog_dir, dry_run=args.dry_run)

    if args.as_json:
        print(json.dumps(report, indent=2))
    else:
        print(render_report(report))

    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
