"""Tests for ``scripts/install-audit-log-hygiene.sh`` (WL-0MUJRQOIT000N34K).

The installer is exercised through a temporary ``HOME`` and a fake ``crontab``
seam (the ``CRONTAB`` environment variable points at a shim that stores the
crontab in a temp file), so the operator's real crontab is never touched.

Run with::

    python3 -m pytest tests/test_install_audit_log_hygiene.py -q
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
_INSTALLER = _REPO_ROOT / "scripts" / "install-audit-log-hygiene.sh"
_MARKER = "# managed by install-audit-log-hygiene.sh (worklog audit debug retention)"

#: A fake ``crontab`` that reads/writes ``$FAKE_CRONTAB_FILE``.
_FAKE_CRONTAB = """#!/usr/bin/env python3
import os
import sys

path = os.environ["FAKE_CRONTAB_FILE"]
args = sys.argv[1:]

if args == ["-l"]:
    if os.path.exists(path):
        sys.stdout.write(open(path, encoding="utf-8").read())
    else:
        sys.stderr.write("no crontab for user\\n")
        sys.exit(1)
elif args == ["-"]:
    data = sys.stdin.read()
    if data.strip():
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(data)
    elif os.path.exists(path):
        os.remove(path)
else:
    sys.stderr.write("usage: crontab [-l | -]\\n")
    sys.exit(2)
"""


@pytest.fixture
def harness(tmp_path):
    """Return ``(env, crontab_file)`` wired to a fake crontab in *tmp_path*."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "crontab"
    fake.write_text(_FAKE_CRONTAB, encoding="utf-8")
    fake.chmod(0o755)

    crontab_file = tmp_path / "crontab.txt"
    env = dict(os.environ)
    env["HOME"] = str(tmp_path)
    env["CRONTAB"] = str(fake)
    env["FAKE_CRONTAB_FILE"] = str(crontab_file)
    return env, crontab_file


def _run_installer(env, *args):
    return subprocess.run(
        [str(_INSTALLER), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------


def test_install_adds_exactly_one_managed_entry(harness):
    env, crontab_file = harness

    result = _run_installer(env)

    assert result.returncode == 0, result.stderr
    assert "installed" in result.stdout.lower()
    content = crontab_file.read_text(encoding="utf-8")
    assert content.count(_MARKER) == 1
    assert "prune_audit_debug_logs.py" in content
    assert "--apply" in content
    assert "hygiene-cron.log" in content


def test_reinstall_is_idempotent(harness):
    env, crontab_file = harness
    _run_installer(env)

    result = _run_installer(env)

    assert result.returncode == 0, result.stderr
    assert "already installed" in result.stdout.lower()
    assert crontab_file.read_text(encoding="utf-8").count(_MARKER) == 1


def test_install_preserves_unrelated_entries(harness):
    env, crontab_file = harness
    crontab_file.write_text(
        "*/5 * * * * echo keep-me\nMAILTO=me@example.com\n", encoding="utf-8"
    )

    _run_installer(env)

    content = crontab_file.read_text(encoding="utf-8")
    assert "echo keep-me" in content
    assert "MAILTO=me@example.com" in content
    assert content.count(_MARKER) == 1


def test_install_replaces_stale_managed_entry(harness):
    env, crontab_file = harness
    crontab_file.write_text(
        f"{_MARKER}\n0 0 * * * echo stale\n*/10 * * * * echo keep-me\n",
        encoding="utf-8",
    )

    _run_installer(env)

    content = crontab_file.read_text(encoding="utf-8")
    assert "echo stale" not in content
    assert "echo keep-me" in content
    assert content.count(_MARKER) == 1
    assert "prune_audit_debug_logs.py" in content


def test_schedule_is_configurable(harness):
    env, crontab_file = harness
    env["HYGIENE_CRON_SCHEDULE"] = "0 4 * * *"

    _run_installer(env)

    assert "0 4 * * *" in crontab_file.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------


def test_dry_run_install_writes_nothing(harness):
    env, crontab_file = harness
    crontab_file.write_text("0 0 * * * echo existing\n", encoding="utf-8")
    before = crontab_file.read_text(encoding="utf-8")

    result = _run_installer(env, "--dry-run")

    assert result.returncode == 0, result.stderr
    assert "dry-run" in result.stdout.lower()
    assert crontab_file.read_text(encoding="utf-8") == before


def test_dry_run_remove_writes_nothing(harness):
    env, crontab_file = harness
    _run_installer(env)
    before = crontab_file.read_text(encoding="utf-8")

    result = _run_installer(env, "--remove", "--dry-run")

    assert result.returncode == 0, result.stderr
    assert crontab_file.read_text(encoding="utf-8") == before


# ---------------------------------------------------------------------------
# Remove
# ---------------------------------------------------------------------------


def test_remove_deletes_only_managed_entry(harness):
    env, crontab_file = harness
    crontab_file.write_text(
        "0 8 * * * echo llm-wiki\nMAILTO=me@example.com\n", encoding="utf-8"
    )
    _run_installer(env)

    result = _run_installer(env, "--remove")

    assert result.returncode == 0, result.stderr
    content = crontab_file.read_text(encoding="utf-8")
    assert _MARKER not in content
    assert "prune_audit_debug_logs.py" not in content
    assert "echo llm-wiki" in content
    assert "MAILTO=me@example.com" in content


def test_remove_when_not_installed_is_noop(harness):
    env, crontab_file = harness
    crontab_file.write_text("0 8 * * * echo llm-wiki\n", encoding="utf-8")

    result = _run_installer(env, "--remove")

    assert result.returncode == 0, result.stderr
    assert "not installed" in result.stdout.lower()
    assert crontab_file.read_text(encoding="utf-8") == "0 8 * * * echo llm-wiki\n"


# ---------------------------------------------------------------------------
# Bounded log rotation
# ---------------------------------------------------------------------------


def test_rotate_log_over_cap_moves_and_empties(harness, tmp_path):
    env, _ = harness
    log = tmp_path / ".audit_debug" / "hygiene-cron.log"
    log.parent.mkdir(parents=True)
    log.write_bytes(b"x" * 100)
    env["HYGIENE_LOG_FILE"] = str(log)
    env["HYGIENE_LOG_MAX_BYTES"] = "10"

    result = _run_installer(env, "--rotate-log")

    assert result.returncode == 0, result.stderr
    assert "rotated" in result.stdout.lower()
    assert (log.parent / "hygiene-cron.log.1").read_bytes() == b"x" * 100
    assert log.read_bytes() == b""


def test_rotate_log_under_cap_is_noop(harness, tmp_path):
    env, _ = harness
    log = tmp_path / ".audit_debug" / "hygiene-cron.log"
    log.parent.mkdir(parents=True)
    log.write_bytes(b"x" * 5)
    env["HYGIENE_LOG_FILE"] = str(log)
    env["HYGIENE_LOG_MAX_BYTES"] = "10"

    result = _run_installer(env, "--rotate-log")

    assert result.returncode == 0, result.stderr
    assert log.read_bytes() == b"x" * 5
    assert not (log.parent / "hygiene-cron.log.1").exists()


def test_rotate_log_missing_file_is_noop(harness, tmp_path):
    env, _ = harness
    env["HYGIENE_LOG_FILE"] = str(tmp_path / ".audit_debug" / "hygiene-cron.log")

    result = _run_installer(env, "--rotate-log")

    assert result.returncode == 0, result.stderr
    assert "nothing to rotate" in result.stdout.lower()


# ---------------------------------------------------------------------------
# Hygiene / contract
# ---------------------------------------------------------------------------


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
def test_help_lists_actions():
    result = subprocess.run(
        ["bash", str(_INSTALLER), "--help"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0
    for token in ("--remove", "--dry-run", "--rotate-log"):
        assert token in result.stdout
