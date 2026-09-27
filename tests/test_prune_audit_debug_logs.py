"""Tests for ``scripts/prune_audit_debug_logs.py`` (WL-0MUJRQNB6005EOVP).

Covers the acceptance criteria of the retention sweep: name guard, age and
size boundaries, missing-root no-op, dry-run no-op, ``--apply`` exact-set
deletion, ``--check`` exit codes, second-apply idempotence, ``--log-file``
audit lines, and OSError skip-and-continue on stat/unlink.

Run with::

    python3 -m pytest tests/test_prune_audit_debug_logs.py -q
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import prune_audit_debug_logs as mod

DAY = 86400
MB = 1024 * 1024


def _make_file(path: Path, size: int = 0, age_days: float = 0.0) -> Path:
    """Create a sparse file of *size* bytes with a controlled mtime."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        fh.truncate(size)
    if age_days:
        mtime = time.time() - age_days * DAY
        os.utime(path, (mtime, mtime))
    return path


def _run(capsys, argv: list[str]):
    code = mod.main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def _select(root: Path, older_than: int = 7, max_size_mb: float = 50.0):
    roots = mod.resolve_roots([str(root)])
    candidates = mod.discover_candidates(roots)
    selected, errors = mod.select_for_removal(candidates, older_than, max_size_mb)
    return selected, errors


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def test_worklog_root_is_non_recursive(tmp_path):
    """Files directly in a .worklog store are found; worktree subdirs are not."""
    root = tmp_path / ".worklog"
    direct = _make_file(root / "audit_debug_direct.jsonl", 1, age_days=30)
    nested = _make_file(
        root / "worktrees" / "w" / "audit_debug_nested.jsonl", 1, age_days=30
    )

    candidates = mod.discover_candidates(mod.resolve_roots([str(root)]))

    assert direct in candidates
    assert nested not in candidates


def test_non_worklog_root_is_recursive(tmp_path):
    """A root not named .worklog (e.g. ~/.audit_debug) is scanned recursively."""
    root = tmp_path / "audit_debug"
    nested = _make_file(root / "a" / "b" / "audit_debug_nested.jsonl", 1, age_days=30)

    candidates = mod.discover_candidates(mod.resolve_roots([str(root)]))

    assert nested in candidates


def test_missing_root_is_noop(tmp_path, capsys):
    code, out, _err = _run(
        capsys, ["--root", str(tmp_path / "does-not-exist"), "--apply"]
    )

    assert code == 0
    assert "0 candidate(s) selected" in out
    assert not (tmp_path / "does-not-exist").exists()


# ---------------------------------------------------------------------------
# Selection: name guard, age boundary, size boundary
# ---------------------------------------------------------------------------


def test_non_matching_names_are_never_selected_or_deleted(tmp_path, capsys):
    root = tmp_path / ".worklog"
    keep_db = _make_file(root / "worklog.db", 10, age_days=30)
    keep_wal = _make_file(root / "worklog.db-wal", 10, age_days=30)
    keep_cfg = _make_file(root / "config.yaml", 10, age_days=30)
    keep_txt = _make_file(root / "audit_debug_notes.txt", 10, age_days=30)
    keep_other = _make_file(root / "other.jsonl", 10, age_days=30)
    target = _make_file(root / "audit_debug_x.jsonl", 10, age_days=30)

    code, _out, _err = _run(capsys, ["--root", str(root), "--apply"])

    assert code == 0
    assert not target.exists()
    for kept in (keep_db, keep_wal, keep_cfg, keep_txt, keep_other):
        assert kept.exists(), f"{kept} must never be touched"


def test_age_boundary_just_inside_and_outside(tmp_path):
    root = tmp_path / ".worklog"
    outside = _make_file(root / "audit_debug_old.jsonl", 1, age_days=7.5)
    inside = _make_file(root / "audit_debug_new.jsonl", 1, age_days=6.5)

    selected, errors = _select(root, older_than=7, max_size_mb=50)

    assert errors == []
    assert outside in selected
    assert inside not in selected


def test_size_boundary_just_under_and_over(tmp_path):
    root = tmp_path / ".worklog"
    under = _make_file(root / "audit_debug_small.jsonl", MB - 1)
    over = _make_file(root / "audit_debug_big.jsonl", MB + 1)

    selected, errors = _select(root, older_than=7, max_size_mb=1)

    assert errors == []
    assert over in selected
    assert under not in selected


# ---------------------------------------------------------------------------
# Modes: dry-run, apply, check
# ---------------------------------------------------------------------------


def test_dry_run_is_default_and_changes_nothing(tmp_path, capsys):
    root = tmp_path / ".worklog"
    target = _make_file(root / "audit_debug_x.jsonl", 5, age_days=30)

    code, out, _err = _run(capsys, ["--root", str(root)])

    assert code == 0
    assert target.exists()
    assert "DRY-RUN" in out
    assert "would remove" in out
    assert "no files were changed" in out


def test_apply_deletes_exactly_the_selected_set(tmp_path, capsys):
    root = tmp_path / ".worklog"
    old = _make_file(root / "audit_debug_old.jsonl", 5, age_days=30)
    new = _make_file(root / "audit_debug_new.jsonl", 5)

    code, out, _err = _run(capsys, ["--root", str(root), "--apply"])

    assert code == 0
    assert not old.exists()
    assert new.exists()
    # one audit line per removed file, with path and bytes
    assert "removed" in out
    assert str(old) in out
    assert "5 bytes" in out


def test_apply_writes_audit_lines_to_log_file(tmp_path, capsys):
    root = tmp_path / ".worklog"
    target = _make_file(root / "audit_debug_x.jsonl", 7, age_days=30)
    log = tmp_path / "hygiene-cron.log"

    code, _out, _err = _run(
        capsys, ["--root", str(root), "--apply", "--log-file", str(log)]
    )

    assert code == 0
    content = log.read_text(encoding="utf-8")
    assert str(target) in content
    assert "7 bytes" in content


def test_check_under_budget_exits_zero_and_deletes_nothing(tmp_path, capsys):
    root = tmp_path / ".worklog"
    target = _make_file(root / "audit_debug_x.jsonl", 10, age_days=30)

    code, out, _err = _run(capsys, ["--root", str(root), "--check", "--budget-gb", "1"])

    assert code == 0
    assert target.exists()
    assert "CHECK OK" in out


def test_check_over_budget_exits_nonzero_and_deletes_nothing(tmp_path, capsys):
    root = tmp_path / ".worklog"
    target = _make_file(root / "audit_debug_x.jsonl", 10, age_days=30)

    code, _out, _err = _run(
        capsys, ["--root", str(root), "--check", "--budget-gb", "0"]
    )

    assert code != 0
    assert target.exists()


def test_second_apply_reports_zero_candidates(tmp_path, capsys):
    root = tmp_path / ".worklog"
    _make_file(root / "audit_debug_x.jsonl", 5, age_days=30)

    code1, _out1, _ = _run(capsys, ["--root", str(root), "--apply"])
    code2, out2, _ = _run(capsys, ["--root", str(root), "--apply"])

    assert code1 == 0
    assert code2 == 0
    assert "0 candidate(s) selected" in out2


# ---------------------------------------------------------------------------
# Robustness: OSError skip-and-continue
# ---------------------------------------------------------------------------


def test_oserror_on_stat_skips_and_continues(tmp_path, capsys, monkeypatch):
    root = tmp_path / ".worklog"
    bad = _make_file(root / "audit_debug_bad.jsonl", 5, age_days=30)
    good = _make_file(root / "audit_debug_good.jsonl", 5, age_days=30)
    real_stat = mod._stat

    def flaky_stat(path):
        if Path(path).name == "audit_debug_bad.jsonl":
            raise OSError("simulated stat failure")
        return real_stat(path)

    monkeypatch.setattr(mod, "_stat", flaky_stat)

    code, _out, err = _run(capsys, ["--root", str(root), "--apply"])

    assert code == 0
    assert not good.exists()  # remaining candidates still processed
    assert bad.exists()  # skipped, not deleted
    assert "simulated stat failure" in err


def test_oserror_on_unlink_skips_and_continues(tmp_path, capsys, monkeypatch):
    root = tmp_path / ".worklog"
    bad = _make_file(root / "audit_debug_bad.jsonl", 5, age_days=30)
    good = _make_file(root / "audit_debug_good.jsonl", 5, age_days=30)
    real_unlink = mod._unlink

    def flaky_unlink(path):
        if Path(path).name == "audit_debug_bad.jsonl":
            raise OSError("simulated unlink failure")
        return real_unlink(path)

    monkeypatch.setattr(mod, "_unlink", flaky_unlink)

    code, _out, err = _run(capsys, ["--root", str(root), "--apply"])

    assert code == 0
    assert not good.exists()
    assert bad.exists()
    assert "simulated unlink failure" in err


# ---------------------------------------------------------------------------
# CLI contract
# ---------------------------------------------------------------------------


def test_help_documents_every_flag_and_default():
    help_text = mod.build_parser().format_help()

    for flag in (
        "--root",
        "--older-than",
        "--max-size",
        "--budget-gb",
        "--log-file",
        "--apply",
        "--check",
    ):
        assert flag in help_text, f"{flag} must be documented in --help"
    # defaults surfaced by ArgumentDefaultsHelpFormatter
    assert "7" in help_text
    assert "50" in help_text
    assert "5" in help_text
