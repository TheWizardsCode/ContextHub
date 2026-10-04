#!/usr/bin/env python3
"""
pane-triage — approval-gated close of idle panes in the invoking herdr workspace.

Manual, workspace-scoped complement to the automatic pane-close reaper. Idle
state is classified by the **shared** classifier via the ContextHub bridge CLI
(``packages/herdr/dist/pane-close-cli.js``); this skill owns rendering, the
approval prompt, re-verification, and the closure ledger. It never closes
anything without explicit producer approval.

Usage:
    ./scripts/pane-triage.py --dry-run          # report only (default)
    ./scripts/pane-triage.py                    # report, then prompt for approval
    ./scripts/pane-triage.py --json             # machine-readable report
    ./scripts/pane-triage.py --workspace w2V    # override workspace detection

Exit codes:
    0  report rendered (and, if approved, closure completed)
    1  bridge/workspace error (fail-closed, nothing closed)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any

_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from pane_triage import (
    BridgeError,
    build_report,
    classify_via_bridge,
    close_selected_panes,
    recommend_to_close,
    render_ledger,
    render_log_tail,
    resolve_workspace,
    select_approval,
)

# Number of log lines read from the pane for the tail (newline-delimited).
_PANE_TAIL_LINES = 20


def _read_pane_tail(pane_id: str) -> list[str]:
    """Return the last ``_PANE_TAIL_LINES`` lines of a pane's output.

    Fail-safe: an unreadable pane yields an empty list (the caller renders a
    placeholder) rather than aborting the report.
    """
    try:
        proc = subprocess.run(
            ["herdr", "pane", "read", pane_id],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except Exception:  # noqa: BLE001 - best-effort tail
        return []
    if proc.returncode != 0:
        return []
    lines = proc.stdout.splitlines()
    return lines[-_PANE_TAIL_LINES:]


def _invoking_pane_id() -> str | None:
    """Return the invoking pane id from the environment, if set."""
    return os.environ.get("HERDR_PANE_ID") or os.environ.get("HERDR_PANE") or None


def _print_report(
    panes: list[dict[str, Any]],
    invoking_pane_id: str | None,
    show_tails: bool,
) -> list[dict[str, Any]]:
    """Print the report and per-idle-pane tails; return recommendations."""
    print(build_report(panes, invoking_pane_id))

    if show_tails:
        idle = [p for p in panes if p.get("close")]
        for pane in idle:
            snapshot = pane.get("reasonSnapshot") or {}
            needs_review = bool(snapshot.get("needsProducerReview"))
            # Prefer the tail supplied by the bridge (it read the session log
            # with the shared reader); fall back to `herdr pane read`.
            tail = pane.get("sessionTail") or _read_pane_tail(pane.get("paneId", ""))
            print(render_log_tail(pane.get("paneTitle", ""), needs_review, tail))
            print()

    recommendations = recommend_to_close(panes, invoking_pane_id)
    print("## Recommended to close")
    print()
    if recommendations:
        for index, pane in enumerate(recommendations, start=1):
            print(f"{index}. {pane.get('paneId')} — {pane.get('paneTitle')}")
    else:
        print("_None._")
    print()
    return recommendations


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workspace",
        default=None,
        help="Workspace id (defaults to HERDR_WORKSPACE_ID / herdr pane current).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report only; never prompt or close (default when not interactive).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the report as JSON (no prompts, no closure).",
    )
    parser.add_argument(
        "--response",
        default=None,
        help="Non-interactive approval response (yes/select N,M/no).",
    )
    parser.add_argument(
        "--no-tails",
        action="store_true",
        help="Skip fetching per-pane log tails.",
    )
    args = parser.parse_args(argv)

    try:
        workspace = args.workspace or resolve_workspace(os.environ)
        invoking_pane_id = _invoking_pane_id()
        panes = classify_via_bridge(workspace, invoking_pane_id)
    except BridgeError as exc:
        print(f"pane-triage: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(
            json.dumps(
                {
                    "workspace": workspace,
                    "invokingPaneId": invoking_pane_id,
                    "panes": panes,
                    "recommended": [
                        p.get("paneId")
                        for p in recommend_to_close(panes, invoking_pane_id)
                    ],
                },
                indent=2,
            )
        )
        return 0

    recommendations = _print_report(
        panes, invoking_pane_id, show_tails=not args.no_tails
    )

    if args.dry_run or not recommendations:
        return 0

    response = args.response
    if response is None:
        try:
            response = input(
                "Close recommended panes? [yes / select N,M / no]: "
            )
        except EOFError:
            response = "no"

    approved_ids = select_approval(
        response, [p.get("paneId", "") for p in recommendations]
    )
    if not approved_ids:
        print("\nNo panes approved for closure.")
        return 0

    result = close_selected_panes(
        approved_pane_ids=approved_ids,
        current_panes=panes,
        close_fn=_close_pane,
        list_panes_fn=lambda: classify_via_bridge(workspace, invoking_pane_id),
        invoking_pane_id=invoking_pane_id,
    )
    print()
    print(render_ledger(result))
    return 0


def _close_pane(pane_id: str) -> bool:
    """Close one pane via herdr. Returns True on success (fail-closed)."""
    try:
        proc = subprocess.run(
            ["herdr", "pane", "close", pane_id],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except Exception:  # noqa: BLE001 - recorded as failed
        return False
    return proc.returncode == 0


if __name__ == "__main__":
    raise SystemExit(main())
