#!/usr/bin/env python3
"""prune_audit_debug_logs.py — retention sweep for audit debug JSONL dumps.

Work item: WL-0MUJRQNB6005EOVP (parent WL-0MUJL0PTS009MC8F).

Legacy ``audit_debug_*.jsonl`` forensic dumps accumulated unbounded under
worklog stores (48 files / 12.5 GB in ContextHub ``.worklog``; 33 files /
11.3 GB in ``open_source_llm/.worklog``) and under ``~/.audit_debug``. They
make recursive greps read multi-GB inputs and inflate every worklog/audit
operation. This script discovers them, selects those exceeding an age or size
threshold, and — only with ``--apply`` — deletes them.

It mirrors the conventions of the SorraAgents audit skill's
``cleanup_debug_logs.py`` (dry-run default, ``--older-than``, stdlib only) but
is repo-local and **does not edit** that skill (repo-boundary rule).

Discovery locations
-------------------

* every ``~/projects/*/.worklog/`` store — files **directly** in the store
  only (non-recursive, so ``.worklog/worktrees/**`` is never swept);
* ``~/.audit_debug/**`` — recursive.

``--root`` (repeatable) replaces the default locations. A root whose basename
is ``.worklog`` is scanned non-recursively; every other root is scanned
recursively. This makes discovery testable against a temporary tree.

Selection
---------

Name-guarded to ``audit_debug_*.jsonl``: a candidate is selected when it is
strictly older than ``--older-than`` days (default 7) **or** strictly larger
than ``--max-size`` MB (default 50). Every other file (``worklog.db``,
WAL/SHM sidecars, ``config.yaml``, worktrees, …) is never considered.

Modes
-----

* default — dry-run; prints the selection and changes nothing on disk;
* ``--apply`` — deletes the selected set, emitting one audit line per removed
  file (path + bytes) to stdout and, when ``--log-file`` is given, to an
  append-only log;
* ``--check`` — deletes nothing and exits non-zero when the total debug-log
  footprint exceeds ``--budget-gb`` (default 5).

Deletions are resilient: an ``OSError`` while stat-ing or unlinking a
candidate is logged and skipped, and the sweep continues with the rest.

Exit codes
----------

* 0 — success (dry-run, apply, or ``--check`` within budget);
* 1 — ``--check`` over budget, invalid argument, or usage error.

Stdlib only; no network.

Policy and runbook: ``docs/dev/audit-debug-log-retention.md``.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

DEFAULT_OLDER_THAN_DAYS = 7
DEFAULT_MAX_SIZE_MB = 50.0
DEFAULT_BUDGET_GB = 5.0

#: Default discovery locations, relative to the user's home directory.
DEFAULT_PROJECTS_GLOB = "projects/*/.worklog"
DEFAULT_AUDIT_DIR = ".audit_debug"

EXIT_OK = 0
EXIT_OVER_BUDGET = 1

_MB = 1024 * 1024
_GB = 1024 * 1024 * 1024


def _is_debug_log(name: str) -> bool:
    """Return True only for ``audit_debug_*.jsonl`` basenames."""
    return name.startswith("audit_debug_") and name.endswith(".jsonl")


def _stat(path: Path) -> os.stat_result:
    """Stat *path* (indirection point so tests can inject ``OSError``)."""
    return path.stat()


def _unlink(path: Path) -> None:
    """Unlink *path* (indirection point so tests can inject ``OSError``)."""
    path.unlink()


def resolve_roots(root_args: list[str] | None) -> list[tuple[Path, bool]]:
    """Return the ``(path, recursive)`` search roots to sweep.

    With no ``--root`` the defaults are used: every ``~/projects/*/.worklog``
    store (non-recursive) plus ``~/.audit_debug`` (recursive). With one or
    more ``--root`` values those replace the defaults; a root named
    ``.worklog`` is scanned non-recursively, every other root recursively.
    """
    if root_args:
        roots: list[tuple[Path, bool]] = []
        for raw in root_args:
            path = Path(raw).expanduser()
            roots.append((path, path.name != ".worklog"))
        return roots

    home = Path.home()
    roots = [(store, False) for store in sorted(home.glob(DEFAULT_PROJECTS_GLOB))]
    roots.append((home / DEFAULT_AUDIT_DIR, True))
    return roots


def discover_candidates(roots: list[tuple[Path, bool]]) -> list[Path]:
    """Discover ``audit_debug_*.jsonl`` files under each root.

    Missing roots are a no-op (no candidates, no error). Results are
    de-duplicated and sorted for deterministic output.
    """
    found: set[Path] = set()
    for root, recursive in roots:
        try:
            if not root.is_dir():
                continue
        except OSError:
            continue
        try:
            iterator = (
                root.rglob("audit_debug_*.jsonl")
                if recursive
                else root.glob("audit_debug_*.jsonl")
            )
            for path in iterator:
                try:
                    if path.is_file() and _is_debug_log(path.name):
                        found.add(path)
                except OSError:
                    continue
        except OSError:
            continue
    return sorted(found)


def select_for_removal(
    candidates: list[Path],
    older_than_days: float,
    max_size_mb: float,
    now: float | None = None,
) -> tuple[list[Path], list[tuple[Path, str]]]:
    """Split *candidates* into ``(selected, errors)``.

    A candidate is selected when its ``mtime`` is strictly older than
    *older_than_days* **or** its size is strictly larger than *max_size_mb*
    MiB. A candidate whose ``stat`` raises ``OSError`` is returned in
    *errors* (and skipped) so the sweep can continue.
    """
    if now is None:
        now = time.time()
    cutoff = now - older_than_days * 86400
    max_bytes = max_size_mb * _MB
    selected: list[Path] = []
    errors: list[tuple[Path, str]] = []
    for path in candidates:
        try:
            stat_result = _stat(path)
        except OSError as exc:
            errors.append((path, str(exc)))
            continue
        if stat_result.st_mtime < cutoff or stat_result.st_size > max_bytes:
            selected.append(path)
    return selected, errors


def total_footprint(candidates: list[Path]) -> int:
    """Return the summed size in bytes of *candidates* (unstatable → skipped)."""
    total = 0
    for path in candidates:
        try:
            total += _stat(path).st_size
        except OSError:
            continue
    return total


def _format_bytes(size: int) -> str:
    return f"{size} bytes ({size / _GB:.2f} GB)"


def _remove_selected(selected: list[Path], log_file: Path | None) -> int:
    """Delete *selected*, printing/auditing one line per removed file."""
    removed = 0
    audit_lines: list[str] = []
    for path in selected:
        try:
            size = _stat(path).st_size
        except OSError:
            size = 0
        try:
            _unlink(path)
        except OSError as exc:
            print(f"  error removing {path}: {exc}", file=sys.stderr)
            continue
        removed += 1
        line = f"removed {path} ({size} bytes)"
        print(f"  {line}")
        audit_lines.append(line)

    if log_file is not None and audit_lines:
        try:
            with open(log_file, "a", encoding="utf-8") as fh:
                for line in audit_lines:
                    fh.write(line + "\n")
        except OSError as exc:
            print(
                f"  warning: could not write log {log_file}: {exc}",
                file=sys.stderr,
            )
    return removed


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser (documented flags + defaults)."""
    parser = argparse.ArgumentParser(
        prog="prune_audit_debug_logs.py",
        description=(
            "Prune stale audit_debug_*.jsonl forensic dumps under "
            "~/projects/*/.worklog stores and ~/.audit_debug. Dry-run by "
            "default; pass --apply to delete."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--root",
        action="append",
        default=None,
        metavar="PATH",
        help=(
            "Search root (repeatable). Overrides the defaults. A path named "
            ".worklog is scanned non-recursively; every other path recursively."
        ),
    )
    parser.add_argument(
        "--older-than",
        type=int,
        default=DEFAULT_OLDER_THAN_DAYS,
        metavar="DAYS",
        help="Select files strictly older than this many days.",
    )
    parser.add_argument(
        "--max-size",
        type=float,
        default=DEFAULT_MAX_SIZE_MB,
        metavar="MB",
        help="Select files strictly larger than this many MB.",
    )
    parser.add_argument(
        "--budget-gb",
        type=float,
        default=DEFAULT_BUDGET_GB,
        metavar="GB",
        help="--check fails when the total debug-log footprint exceeds this many GB.",
    )
    parser.add_argument(
        "--log-file",
        default=None,
        metavar="PATH",
        help="Append an audit line per removed file to this file.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--apply",
        action="store_true",
        help="Delete the selected files (default: dry-run).",
    )
    mode.add_argument(
        "--check",
        action="store_true",
        help=(
            "Delete nothing; exit non-zero when the total debug-log footprint "
            "exceeds --budget-gb."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.older_than < 0:
        print("error: --older-than must be >= 0", file=sys.stderr)
        return EXIT_OVER_BUDGET
    if args.max_size < 0:
        print("error: --max-size must be >= 0", file=sys.stderr)
        return EXIT_OVER_BUDGET
    if args.budget_gb < 0:
        print("error: --budget-gb must be >= 0", file=sys.stderr)
        return EXIT_OVER_BUDGET

    roots = resolve_roots(args.root)
    candidates = discover_candidates(roots)

    if args.check:
        footprint = total_footprint(candidates)
        budget_bytes = args.budget_gb * _GB
        print(
            f"[CHECK] {len(candidates)} debug log(s); footprint "
            f"{_format_bytes(footprint)}; budget {args.budget_gb} GB."
        )
        if footprint > budget_bytes:
            print(
                "CHECK FAILED: debug-log footprint exceeds budget.",
                file=sys.stderr,
            )
            return EXIT_OVER_BUDGET
        print("CHECK OK: footprint within budget.")
        return EXIT_OK

    selected, stat_errors = select_for_removal(
        candidates, args.older_than, args.max_size
    )
    for path, err in stat_errors:
        print(f"  warning: could not stat {path}: {err}", file=sys.stderr)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(
        f"[{mode}] {len(selected)} candidate(s) selected out of "
        f"{len(candidates)} discovered (older-than {args.older_than}d "
        f"OR > {args.max_size} MB)."
    )

    if not selected:
        if args.apply:
            print("No candidates to remove.")
        else:
            print("No candidates selected. Dry-run: nothing to do.")
        return EXIT_OK

    if args.apply:
        log_file = Path(args.log_file).expanduser() if args.log_file else None
        removed = _remove_selected(selected, log_file)
        print(f"APPLY complete: removed {removed} file(s).")
    else:
        for path in selected:
            try:
                size = _stat(path).st_size
            except OSError:
                size = 0
            print(f"  would remove {path} ({size} bytes)")
        print("Dry-run: no files were changed. Re-run with --apply to delete.")

    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
