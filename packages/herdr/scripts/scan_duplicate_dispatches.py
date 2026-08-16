#!/usr/bin/env python3
"""Scan herdr downtime dispatch logs for re-dispatched work items.

Reproduces the duplicate-dispatch evidence scan from RCA
WL-0MSRBFFLN005W3VT ("RCA: Downtime dispatcher re-dispatches same item"):
for every `.worklog/downtime-dispatches.log` under the given roots, group
entries by (kind, itemId) and report every pair dispatched more than once,
with the first/last dispatch timestamps and the gap between them.

A duplicate pair means the downtime worker opened more than one pane for the
same work item without the item's state durably changing between dispatches
— the re-dispatch behaviour the RCA investigates.

Usage:
    python3 packages/herdr/scripts/scan-duplicate-dispatches.py [root ...] [--json] [--since ISO]

Roots default to the five worklog roots observed on this host. `--since`
filters to entries dispatched at or after the given ISO-8601 timestamp
(useful for focusing on post-fix evidence). Output is a human-readable table
by default; `--json` emits a machine-readable report. Exit code is always 0
(the tool reports; it does not fail on findings).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# The five worklog roots with an active downtime dispatch log on this host
# (dispatch logs are written under each project's `.worklog/` directory).
DEFAULT_ROOTS = [
    "/home/rgardler/projects/ContextHub",
    "/home/rgardler/projects/SorraAgents",
    "/home/rgardler/projects/Tableau-Card-Engine",
    "/home/rgardler/projects/dev-scripts",
    "/home/rgardler/projects/open_source_llm",
]

LOG_REL = Path(".worklog") / "downtime-dispatches.log"


def read_entries(log_path: Path) -> list[dict]:
    """Parse a dispatch log file into entries (fail-safe: skip bad lines).

    Returns an empty list for a missing/unreadable file, mirroring
    `readDowntimeLogEntries` in packages/herdr/src/downtime-log.ts.
    """
    entries: list[dict] = []
    try:
        raw = log_path.read_text(encoding="utf-8")
    except OSError:
        return []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(parsed, dict):
            entries.append(parsed)
    return entries


def find_duplicates(
    roots: list[str], since: str | None = None
) -> list[dict]:
    """Scan the roots' dispatch logs for (kind, itemId) pairs dispatched >1.

    Returns a list of report dicts, one per duplicate pair:
    ``{root, kind, itemId, title, count, firstDispatchedAt, lastDispatchedAt,
    gapSeconds}``. Entries without an itemId/kind (e.g. persistent-error
    events) are ignored.
    """
    cutoff = None
    if since:
        cutoff = datetime.fromisoformat(since.replace("Z", "+00:00"))

    reports: list[dict] = []
    for root in roots:
        log_path = Path(root) / LOG_REL
        entries = read_entries(log_path)
        by_pair: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for e in entries:
            item_id = e.get("itemId")
            kind = e.get("kind")
            dispatched_at = e.get("dispatchedAt")
            if not isinstance(item_id, str) or not item_id:
                continue
            if not isinstance(kind, str) or not kind:
                continue
            if not isinstance(dispatched_at, str) or not dispatched_at:
                continue
            if cutoff:
                try:
                    ts = datetime.fromisoformat(dispatched_at.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if ts < cutoff:
                    continue
            by_pair[(kind, item_id)].append(e)

        for (kind, item_id), group in sorted(by_pair.items()):
            if len(group) < 2:
                continue
            times = [g["dispatchedAt"] for g in group]
            times_sorted = sorted(times)
            gap_seconds = None
            if len(times_sorted) >= 2:
                t0 = datetime.fromisoformat(times_sorted[0].replace("Z", "+00:00"))
                t1 = datetime.fromisoformat(times_sorted[-1].replace("Z", "+00:00"))
                gap_seconds = round((t1 - t0).total_seconds())
            reports.append(
                {
                    "root": str(Path(root).resolve()),
                    "kind": kind,
                    "itemId": item_id,
                    "title": group[0].get("title", ""),
                    "count": len(group),
                    "firstDispatchedAt": times_sorted[0],
                    "lastDispatchedAt": times_sorted[-1],
                    "gapSeconds": gap_seconds,
                }
            )
    return reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Scan herdr downtime dispatch logs for work items dispatched "
            "more than once (RCA WL-0MSRBFFLN005W3VT evidence scan)."
        )
    )
    parser.add_argument("roots", nargs="*", help="worklog roots to scan (default: the five host roots)")
    parser.add_argument(
        "--json", action="store_true", help="emit machine-readable JSON report"
    )
    parser.add_argument(
        "--since",
        metavar="ISO",
        help="only consider entries dispatched at/after this ISO-8601 timestamp",
    )
    args = parser.parse_args(argv)

    roots = args.roots or DEFAULT_ROOTS
    reports = find_duplicates(roots, since=args.since)

    if args.json:
        print(json.dumps({"roots": [str(Path(r).resolve()) for r in roots], "duplicates": reports}, indent=2))
        return 0

    if not reports:
        print("No duplicate (kind, itemId) dispatch pairs found.")
        return 0

    print(f"Duplicate dispatch pairs across {len(roots)} roots:\n")
    for r in reports:
        gap = f"{r['gapSeconds']}s" if r["gapSeconds"] is not None else "?"
        print(
            f"  {r['kind']:<10} {r['itemId']} x{r['count']}  "
            f"({r['root']})"
        )
        print(f"             first={r['firstDispatchedAt']}  last={r['lastDispatchedAt']}  gap={gap}")
        if r["title"]:
            print(f"             title: {r['title']}")
    print(f"\nTotal duplicate pairs: {len(reports)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
