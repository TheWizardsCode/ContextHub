"""Tests for the herdr duplicate-dispatch scan script.

Validates the evidence-reproduction logic behind RCA WL-0MSRBFFLN005W3VT:
grouping `.worklog/downtime-dispatches.log` entries by (kind, itemId) and
reporting pairs dispatched more than once. Every test asserts observable
behaviour of `find_duplicates` / `read_entries` via the public API.

Run with:
    cd /path/to/ContextHub
    python3 -m pytest packages/herdr/scripts/tests/test_scan_duplicate_dispatches.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from scan_duplicate_dispatches import find_duplicates, read_entries


@pytest.fixture()
def root_a(tmp_path: Path) -> Path:
    """A worklog root whose dispatch log contains one duplicate pair and one
    singleton (a normal dispatch), plus a malformed line to exercise the
    fail-safe parse."""
    log = tmp_path / ".worklog" / "downtime-dispatches.log"
    log.parent.mkdir(parents=True)
    log.write_text(
        "\n".join(
            [
                json.dumps(
                    {"itemId": "WL-A", "kind": "audit", "dispatchedAt": "2026-08-10T21:20:53.909Z", "cwd": str(tmp_path), "title": "t"}
                ),
                json.dumps(
                    {"itemId": "WL-A", "kind": "audit", "dispatchedAt": "2026-08-10T21:20:53.923Z", "cwd": str(tmp_path), "title": "t"}
                ),
                json.dumps(
                    {"itemId": "WL-B", "kind": "plan", "dispatchedAt": "2026-08-12T11:05:30.321Z", "cwd": str(tmp_path), "title": "once"}
                ),
                "not-json{{{",
            ]
        )
        + "\n"
    )
    return tmp_path


def test_read_entries_skips_malformed_lines_and_missing_file(root_a: Path) -> None:
    entries = read_entries(root_a / ".worklog" / "downtime-dispatches.log")
    assert len(entries) == 3  # the malformed line is skipped (fail-safe)
    assert read_entries(root_a / "no-such" / "downtime-dispatches.log") == []


def test_find_duplicates_reports_re_dispatched_pairs(root_a: Path) -> None:
    reports = find_duplicates([str(root_a)])
    assert len(reports) == 1
    r = reports[0]
    assert r["kind"] == "audit"
    assert r["itemId"] == "WL-A"
    assert r["count"] == 2
    assert r["firstDispatchedAt"] == "2026-08-10T21:20:53.909Z"
    assert r["lastDispatchedAt"] == "2026-08-10T21:20:53.923Z"
    assert r["gapSeconds"] == 0  # 14 ms rounds to 0 s


def test_find_duplicates_ignores_singletons(root_a: Path) -> None:
    reports = find_duplicates([str(root_a)])
    assert all(r["itemId"] != "WL-B" for r in reports)  # single dispatch is not a duplicate


def test_find_duplicates_aggregates_across_roots(tmp_path: Path) -> None:
    root_b = tmp_path / "root-b"
    (root_b / ".worklog").mkdir(parents=True)
    (root_b / ".worklog" / "downtime-dispatches.log").write_text(
        json.dumps({"itemId": "WL-C", "kind": "plan", "dispatchedAt": "2026-08-09T00:46:28.620Z", "cwd": str(root_b)})
        + "\n"
        + json.dumps({"itemId": "WL-C", "kind": "plan", "dispatchedAt": "2026-08-09T01:17:00.634Z", "cwd": str(root_b)})
        + "\n"
    )
    reports = find_duplicates([str(root_b)])
    assert len(reports) == 1
    assert reports[0]["itemId"] == "WL-C"
    assert reports[0]["count"] == 2
    assert reports[0]["root"] == str(root_b.resolve())


def test_find_duplicates_since_filters_to_recent_entries(root_a: Path) -> None:
    # Both WL-A entries are 2026-08-10; a since cutoff after them excludes the pair.
    reports = find_duplicates([str(root_a)], since="2026-08-11T00:00:00Z")
    assert reports == []
    reports = find_duplicates([str(root_a)], since="2026-08-10T21:20:53.000Z")
    assert len(reports) == 1
