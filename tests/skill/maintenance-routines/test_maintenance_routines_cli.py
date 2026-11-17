#!/usr/bin/env python3
# <!-- REFACTOR-WL-0MW34DEYQ007POFW
# smell: formatting
# severity: low
# description: Shebang is present but file is not executable
# -->
"""
Integration tests for the maintenance-routines skill.

These tests drive the real CLI (`skill/maintenance-routines/scripts/
maintenance_routines.py`) as a subprocess against a throwaway project root, so
the whole path — argument parsing, config resolution, refusal handling, the
atomic write and the JSON report — is exercised exactly as an operator or a
scheduled `/skill:maintenance-routines` session would run it.

Coverage maps to the work-item acceptance criteria (`WL-0MVIDWJ090090J3Q`):

- AC1  the three daily routines (`/skill:test` 07:00, `/skill:standup` 08:00,
       `/skill/refactor` 09:00) end up in `.worklog/scheduled-prompts.json`,
- AC2  reconcile is non-destructive/idempotent, refusals are fail-closed, and
       `--dry-run` writes nothing,
- AC4  the `wl init` template is already canonical, so the skill and
       `templates/scheduled-prompts.json` cannot silently drift apart.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "skill" / "maintenance-routines" / "scripts" / "maintenance_routines.py"
TEMPLATE = REPO_ROOT / "templates" / "scheduled-prompts.json"

REQUIRED_IDS = ["/skill:test", "/skill:standup", "/skill:refactor"]
REQUIRED_TIMES = {"07:00": "/skill:test", "08:00": "/skill:standup", "09:00": "/skill:refactor"}


class MaintenanceRoutinesIntegrationTestCase(unittest.TestCase):
    """Base case: a temporary project root with a `.worklog/` directory."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.worklog = self.root / ".worklog"
        self.worklog.mkdir()
        self.config_path = self.worklog / "scheduled-prompts.json"

    def run_skill(self, *extra, root=None):
        """Run the skill CLI as a subprocess; returns (exit_code, stdout, stderr)."""
        command = [sys.executable, str(SCRIPT), "--root", str(root or self.root), *extra]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        return result.returncode, result.stdout, result.stderr

    def run_skill_json(self, *extra, root=None):
        code, stdout, stderr = self.run_skill("--json", *extra, root=root)
        try:
            report = json.loads(stdout)
        except ValueError:  # pragma: no cover - diagnostic aid
            self.fail(f"skill did not emit JSON (exit {code})\nstdout: {stdout}\nstderr: {stderr}")
        return code, report

    def write_config(self, payload):
        text = payload if isinstance(payload, str) else json.dumps(payload, indent=2)
        self.config_path.write_text(text, encoding="utf-8")
        return text

    def stored_entries(self):
        return json.loads(self.config_path.read_text(encoding="utf-8"))["entries"]


class TestReconcileIntegration(MaintenanceRoutinesIntegrationTestCase):
    def test_provisions_the_three_daily_routines_into_an_empty_config(self):
        self.write_config({"entries": []})

        code, report = self.run_skill_json()

        self.assertEqual(code, 0)
        self.assertTrue(report["success"])
        self.assertEqual(report["action"], "reconciled")
        entries = self.stored_entries()
        self.assertEqual([entry["id"] for entry in entries], REQUIRED_IDS)
        for entry in entries:
            self.assertEqual(entry["intervalDays"], 1)
            self.assertEqual(entry["priority"], "high")
            self.assertIsNone(entry["lastTriggeredAt"])
            self.assertEqual(REQUIRED_TIMES[entry["time"]], entry["id"])

    def test_migrates_a_legacy_schedule_without_losing_runtime_state(self):
        # The pre-change base set: refactor every 3 days with no time, standup
        # at 06:05, no /skill:test, no priority field anywhere.
        self.write_config(
            {
                "entries": [
                    {
                        "id": "/skill:refactor",
                        "prompt": "/skill:refactor",
                        "intervalDays": 3,
                        "lastTriggeredAt": "2026-11-03T09:00:00.000Z",
                    },
                    {
                        "id": "/skill:standup",
                        "prompt": "/skill:standup",
                        "intervalDays": 1,
                        "time": "06:05",
                        "lastTriggeredAt": "2026-11-04T06:05:00.000Z",
                    },
                    {"id": "custom", "prompt": "/skill:code-review", "intervalDays": 7,
                     "lastTriggeredAt": None},
                ]
            }
        )

        code, report = self.run_skill_json()

        self.assertEqual(code, 0)
        self.assertEqual(sorted(report["changed"]), sorted(REQUIRED_IDS))
        entries = {entry["id"]: entry for entry in self.stored_entries()}
        self.assertEqual(entries["/skill:refactor"]["intervalDays"], 1)
        self.assertEqual(entries["/skill:refactor"]["time"], "09:00")
        self.assertEqual(
            entries["/skill:refactor"]["lastTriggeredAt"], "2026-11-03T09:00:00.000Z"
        )
        self.assertEqual(entries["/skill:standup"]["time"], "08:00")
        self.assertEqual(entries["/skill:standup"]["priority"], "high")
        self.assertEqual(
            entries["/skill:standup"]["lastTriggeredAt"], "2026-11-04T06:05:00.000Z"
        )
        self.assertEqual(
            entries["custom"],
            {"id": "custom", "prompt": "/skill:code-review", "intervalDays": 7,
             "lastTriggeredAt": None},
        )

    def test_a_second_run_is_a_no_op_and_leaves_the_file_byte_identical(self):
        self.write_config({"entries": []})
        self.run_skill()
        after_first = self.config_path.read_bytes()

        code, report = self.run_skill_json()

        self.assertEqual(code, 0)
        self.assertEqual(report["action"], "unchanged")
        self.assertEqual(report["changed"], [])
        self.assertEqual(self.config_path.read_bytes(), after_first)

    def test_dry_run_reports_the_plan_without_touching_the_file(self):
        original = self.write_config({"entries": []})

        code, report = self.run_skill_json("--dry-run")

        self.assertEqual(code, 0)
        self.assertEqual(report["action"], "would-reconcile")
        self.assertEqual(self.config_path.read_text(encoding="utf-8"), original)

    def test_refuses_a_missing_config_fail_closed(self):
        code, report = self.run_skill_json()

        self.assertEqual(code, 1)
        self.assertFalse(report["success"])
        self.assertEqual(report["reason"], "config-missing")
        self.assertIn("wl init", report["remedy"])
        self.assertEqual(list(self.worklog.iterdir()), [])

    def test_refuses_a_malformed_config_without_repairing_it(self):
        original = self.write_config('{"entries": [{"id": "/skill:test"}')

        code, report = self.run_skill_json()

        self.assertEqual(code, 1)
        self.assertEqual(report["reason"], "config-malformed-json")
        self.assertEqual(self.config_path.read_text(encoding="utf-8"), original)

    def test_human_report_names_the_routines_and_the_action(self):
        self.write_config({"entries": []})

        code, stdout, _ = self.run_skill()

        self.assertEqual(code, 0)
        for routine_id in REQUIRED_IDS:
            self.assertIn(routine_id, stdout)
        self.assertIn("07:00", stdout)
        self.assertIn("Reconciled", stdout)


class TestTemplateAgreement(unittest.TestCase):
    """AC4: the `wl init` template is already the canonical required set."""

    def test_init_template_needs_no_reconcile(self):
        self.assertTrue(TEMPLATE.is_file(), f"missing template {TEMPLATE}")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".worklog").mkdir()
            (root / ".worklog" / "scheduled-prompts.json").write_text(
                TEMPLATE.read_text(encoding="utf-8"), encoding="utf-8"
            )

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(root), "--json"],
                capture_output=True,
                text=True,
                check=False,
            )

            report = json.loads(result.stdout)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(
                report["action"],
                "unchanged",
                "templates/scheduled-prompts.json has drifted from the "
                "maintenance-routines required set",
            )


if __name__ == "__main__":
    unittest.main()
