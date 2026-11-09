#!/usr/bin/env python3
# <!-- REFACTOR-WL-0MW34DE4F0028UF0
# smell: formatting
# severity: low
# description: Shebang is present but file is not executable
# -->
"""
Unit tests for the maintenance-routines skill reconciler.

Coverage maps to the work-item acceptance criteria
(``WL-0MVIDWJ090090J3Q``):

- AC1  the three required routines exist with the exact spec
       (`/skill:test` 07:00, `/skill:standup` 08:00, `/skill:refactor` 09:00;
       daily; `priority: high`),
- AC2  the reconcile is non-destructive and idempotent: absent entries are
       created, drifted `intervalDays`/`time`/`priority` are corrected,
       `lastTriggeredAt` and every foreign/user entry are preserved verbatim,
       a second run is a no-op, absent/malformed configs are refused
       fail-closed with a clear report, and `--dry-run` writes nothing,
- AC6  the reconciler behaviour is pinned by these tests.

Run: ``python3 -m pytest skill/maintenance-routines/tests -q``
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

# Make the skill's scripts importable regardless of the invocation directory.
_SKILL_DIR = Path(__file__).resolve().parent.parent
if str(_SKILL_DIR / "scripts") not in sys.path:
    sys.path.insert(0, str(_SKILL_DIR / "scripts"))

import maintenance_routines as mr

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


class ConfigDirTestCase(unittest.TestCase):
    """Base case with a temporary project root carrying a worklog dir."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.worklog = self.root / ".worklog"
        self.worklog.mkdir()
        self.config_path = self.worklog / "scheduled-prompts.json"

    def write_config(self, payload):
        """Write *payload* (dict or raw string) to the scheduled-prompts file."""
        text = payload if isinstance(payload, str) else json.dumps(payload, indent=2)
        self.config_path.write_text(text, encoding="utf-8")
        return text

    def read_config(self):
        return json.loads(self.config_path.read_text(encoding="utf-8"))

    def read_raw(self):
        return self.config_path.read_text(encoding="utf-8")


def _entry(entry_id, **overrides):
    """Build a valid scheduled-prompt entry for *entry_id*."""
    entry = {
        "id": entry_id,
        "prompt": entry_id,
        "intervalDays": 1,
        "time": "07:00",
        "priority": "high",
        "lastTriggeredAt": None,
    }
    entry.update(overrides)
    return entry


# ---------------------------------------------------------------------------
# AC1 — the required-routines table
# ---------------------------------------------------------------------------


class TestRequiredRoutinesSpec(unittest.TestCase):
    def test_declares_exactly_the_three_daily_high_priority_routines(self):
        spec = [
            {
                "id": routine["id"],
                "intervalDays": routine["intervalDays"],
                "time": routine["time"],
                "priority": routine["priority"],
            }
            for routine in mr.REQUIRED_ROUTINES
        ]
        self.assertEqual(
            spec,
            [
                {
                    "id": "/skill:test",
                    "intervalDays": 1,
                    "time": "07:00",
                    "priority": "high",
                },
                {
                    "id": "/skill:standup",
                    "intervalDays": 1,
                    "time": "08:00",
                    "priority": "high",
                },
                {
                    "id": "/skill:refactor",
                    "intervalDays": 1,
                    "time": "09:00",
                    "priority": "high",
                },
            ],
        )

    def test_every_required_routine_carries_a_valid_priority_and_prompt(self):
        ids = [routine["id"] for routine in mr.REQUIRED_ROUTINES]
        self.assertEqual(len(ids), len(set(ids)), "required ids must be unique")
        for routine in mr.REQUIRED_ROUTINES:
            self.assertIn(routine["priority"], mr.VALID_PRIORITIES)
            self.assertEqual(routine["prompt"], routine["id"])
            self.assertRegex(routine["time"], r"^([01]\d|2[0-3]):[0-5]\d$")


# ---------------------------------------------------------------------------
# Config path resolution
# ---------------------------------------------------------------------------


class TestResolveConfigPath(unittest.TestCase):
    def test_defaults_to_the_worklog_dir_under_the_project_root(self):
        self.assertEqual(
            mr.resolve_config_path(root=Path("/project")),
            Path("/project/.worklog/scheduled-prompts.json"),
        )

    def test_worklog_dir_overrides_the_project_root(self):
        self.assertEqual(
            mr.resolve_config_path(
                root=Path("/ignored"), worklog_dir=Path("/elsewhere/wl")
            ),
            Path("/elsewhere/wl/scheduled-prompts.json"),
        )


# ---------------------------------------------------------------------------
# AC1/AC2 — pure reconcile semantics
# ---------------------------------------------------------------------------


class TestReconcileEntries(unittest.TestCase):
    def test_creates_the_three_routines_in_a_config_with_no_entries(self):
        entries, changes = mr.reconcile_entries([])

        self.assertEqual(len(entries), 3)
        self.assertEqual([c["action"] for c in changes], ["created"] * 3)
        self.assertEqual(
            [entry["id"] for entry in entries],
            ["/skill:test", "/skill:standup", "/skill:refactor"],
        )
        for entry in entries:
            self.assertIsNone(entry["lastTriggeredAt"])
            self.assertEqual(entry["priority"], "high")
            self.assertEqual(entry["intervalDays"], 1)
        self.assertEqual(entries[0]["time"], "07:00")
        self.assertEqual(entries[1]["time"], "08:00")
        self.assertEqual(entries[2]["time"], "09:00")

    def test_appends_missing_routines_after_user_entries(self):
        existing = [
            _entry("/skill:standup", time="08:00",
                   lastTriggeredAt="2026-11-01T08:00:00.000Z"),
            {"id": "custom", "prompt": "/skill:code-review", "intervalDays": 2,
             "lastTriggeredAt": None},
        ]

        entries, changes = mr.reconcile_entries(existing)

        self.assertEqual(
            [entry["id"] for entry in entries],
            ["/skill:standup", "custom", "/skill:test", "/skill:refactor"],
        )
        # Change records follow the required-routines order, one per routine.
        self.assertEqual(
            changes,
            [
                {"id": "/skill:test", "action": "created", "changes": []},
                {"id": "/skill:standup", "action": "unchanged", "changes": []},
                {"id": "/skill:refactor", "action": "created", "changes": []},
            ],
        )
        # The user's runtime state survives untouched.
        self.assertEqual(entries[0]["lastTriggeredAt"], "2026-11-01T08:00:00.000Z")
        self.assertEqual(entries[1], existing[1])

    def test_corrects_drifted_interval_time_and_priority_but_keeps_last_triggered(self):
        drifted = _entry(
            "/skill:test",
            intervalDays=3,
            time="06:05",
            priority="medium",
            lastTriggeredAt="2026-11-04T07:00:00.000Z",
        )

        entries, changes = mr.reconcile_entries([drifted])

        by_id = {entry["id"]: entry for entry in entries}
        test_routine = by_id["/skill:test"]
        self.assertEqual(test_routine["intervalDays"], 1)
        self.assertEqual(test_routine["time"], "07:00")
        self.assertEqual(test_routine["priority"], "high")
        self.assertEqual(test_routine["lastTriggeredAt"], "2026-11-04T07:00:00.000Z")
        changed = {c["id"]: c for c in changes}["/skill:test"]
        self.assertEqual(changed["action"], "updated")
        self.assertEqual(
            [(f["field"], f["from"], f["to"]) for f in changed["changes"]],
            [("intervalDays", 3, 1), ("time", "06:05", "07:00"), ("priority", "medium", "high")],
        )

    def test_adds_a_missing_time_field(self):
        entries, _ = mr.reconcile_entries([_entry("/skill:refactor", time=None)])
        refactor = {e["id"]: e for e in entries}["/skill:refactor"]
        self.assertEqual(refactor["time"], "09:00")

    def test_preserves_unknown_fields_on_a_required_entry(self):
        existing = _entry("/skill:standup", operatorNote="keep me", extra={"a": 1})
        entries, _ = mr.reconcile_entries([existing])
        standup = {e["id"]: e for e in entries}["/skill:standup"]
        self.assertEqual(standup["operatorNote"], "keep me")
        self.assertEqual(standup["extra"], {"a": 1})

    def test_preserves_a_customised_prompt_of_a_required_entry(self):
        existing = _entry("/skill:test", prompt="/skill:test --scope full")
        entries, changes = mr.reconcile_entries([existing])
        test_routine = {e["id"]: e for e in entries}["/skill:test"]
        self.assertEqual(test_routine["prompt"], "/skill:test --scope full")
        test_change = {change["id"]: change for change in changes}["/skill:test"]
        self.assertEqual(test_change, {"id": "/skill:test", "action": "unchanged", "changes": []})

    def test_repairs_a_required_entry_whose_prompt_is_missing(self):
        existing = {"id": "/skill:test", "intervalDays": 1, "time": "07:00",
                    "priority": "high", "lastTriggeredAt": None}
        entries, changes = mr.reconcile_entries([existing])
        test_routine = {e["id"]: e for e in entries}["/skill:test"]
        self.assertEqual(test_routine["prompt"], "/skill:test")
        self.assertEqual(
            [(f["field"], f["to"]) for f in changes[0]["changes"]], [("prompt", "/skill:test")]
        )

    def test_is_idempotent_for_an_already_canonical_config(self):
        entries, _ = mr.reconcile_entries([])
        again, changes = mr.reconcile_entries(entries)
        self.assertEqual(again, entries)
        self.assertEqual([change["action"] for change in changes], ["unchanged"] * 3)

    def test_preserves_non_dict_entries_verbatim(self):
        entries, changes = mr.reconcile_entries(["not-an-entry", 42])
        self.assertEqual(entries[:2], ["not-an-entry", 42])
        self.assertEqual(len(entries), 5)
        self.assertEqual([c["action"] for c in changes], ["created"] * 3)

    def test_does_not_mutate_the_input_entries(self):
        existing = [_entry("/skill:test", priority="low")]
        snapshot = json.loads(json.dumps(existing))
        mr.reconcile_entries(existing)
        self.assertEqual(existing, snapshot)


# ---------------------------------------------------------------------------
# AC2 — file-level reconcile, refusal paths, dry-run
# ---------------------------------------------------------------------------


class TestReconcileFile(ConfigDirTestCase):
    def test_creates_the_routines_and_reports_the_change(self):
        self.write_config({"entries": []})

        report = mr.reconcile(root=self.root)

        self.assertTrue(report["success"])
        self.assertEqual(report["action"], "reconciled")
        self.assertEqual(
            report["changed"], ["/skill:test", "/skill:standup", "/skill:refactor"]
        )
        stored = self.read_config()
        self.assertEqual([e["id"] for e in stored["entries"]],
                         ["/skill:test", "/skill:standup", "/skill:refactor"])
        self.assertEqual(stored["entries"][2]["time"], "09:00")

    def test_second_run_is_a_no_op_with_identical_bytes(self):
        self.write_config({"entries": []})
        mr.reconcile(root=self.root)
        first = self.read_raw()

        report = mr.reconcile(root=self.root)

        self.assertTrue(report["success"])
        self.assertEqual(report["action"], "unchanged")
        self.assertEqual(report["changed"], [])
        self.assertEqual(self.read_raw(), first)

    def test_preserves_last_triggered_state_across_a_reconcile(self):
        self.write_config(
            {"entries": [_entry("/skill:test", lastTriggeredAt="2026-11-04T07:00:00.000Z")]}
        )
        mr.reconcile(root=self.root)
        stored = {e["id"]: e for e in self.read_config()["entries"]}
        self.assertEqual(stored["/skill:test"]["lastTriggeredAt"], "2026-11-04T07:00:00.000Z")

    def test_preserves_unknown_root_keys_and_foreign_entries(self):
        foreign = {"id": "custom", "prompt": "/skill:code-review", "intervalDays": 2,
                   "lastTriggeredAt": None, "note": "mine"}
        self.write_config({"version": 7, "entries": [foreign]})

        mr.reconcile(root=self.root)

        stored = self.read_config()
        self.assertEqual(stored["version"], 7)
        self.assertEqual(stored["entries"][0], foreign)

    def test_dry_run_reports_the_plan_without_writing(self):
        original = self.write_config(
            {"entries": [_entry("/skill:test", priority="low")]}
        )

        report = mr.reconcile(root=self.root, dry_run=True)

        self.assertTrue(report["success"])
        self.assertTrue(report["dry_run"])
        self.assertEqual(report["action"], "would-reconcile")
        self.assertEqual(report["changed"], ["/skill:test", "/skill:standup", "/skill:refactor"])
        self.assertEqual(self.read_raw(), original)

    def test_refuses_a_missing_config_and_creates_nothing(self):
        report = mr.reconcile(root=self.root)

        self.assertFalse(report["success"])
        self.assertEqual(report["action"], "refused")
        self.assertEqual(report["reason"], "config-missing")
        self.assertTrue(report["remedy"])
        self.assertFalse(self.config_path.exists())

    def test_refuses_malformed_json_and_leaves_the_file_untouched(self):
        original = self.write_config("{not json")

        report = mr.reconcile(root=self.root)

        self.assertFalse(report["success"])
        self.assertEqual(report["action"], "refused")
        self.assertEqual(report["reason"], "config-malformed-json")
        self.assertTrue(report["remedy"])
        self.assertEqual(self.read_raw(), original)

    def test_refuses_a_config_without_an_entries_list(self):
        original = self.write_config({"prompts": []})

        report = mr.reconcile(root=self.root)

        self.assertFalse(report["success"])
        self.assertEqual(report["reason"], "config-entries-not-a-list")
        self.assertEqual(self.read_raw(), original)

    def test_refuses_a_non_object_root(self):
        original = self.write_config("[]")
        report = mr.reconcile(root=self.root)
        self.assertFalse(report["success"])
        self.assertEqual(report["reason"], "config-not-an-object")
        self.assertEqual(self.read_raw(), original)

    def test_leaves_no_temporary_files_behind(self):
        self.write_config({"entries": []})
        mr.reconcile(root=self.root)
        leftovers = sorted(p.name for p in self.worklog.iterdir()
                           if p.name != "scheduled-prompts.json")
        self.assertEqual(leftovers, [])

    def test_writes_json_with_a_trailing_newline(self):
        self.write_config({"entries": []})
        mr.reconcile(root=self.root)
        self.assertTrue(self.read_raw().endswith("\n"))

    def test_reports_preserved_foreign_entry_ids(self):
        self.write_config({"entries": [{"id": "custom", "prompt": "/x", "intervalDays": 1,
                                        "lastTriggeredAt": None}]})
        report = mr.reconcile(root=self.root)
        self.assertEqual(report["preserved_entry_ids"], ["custom"])


# ---------------------------------------------------------------------------
# CLI surface (AC1 invocation, AC2 dry-run)
# ---------------------------------------------------------------------------


class TestCli(ConfigDirTestCase):
    def test_json_invocation_reconciles_and_exits_zero(self):
        self.write_config({"entries": []})

        code = mr.main(["--root", str(self.root), "--json"])

        self.assertEqual(code, 0)
        self.assertEqual(len(self.read_config()["entries"]), 3)

    def test_dry_run_flag_writes_nothing_and_exits_zero(self):
        original = self.write_config({"entries": []})
        code = mr.main(["--root", str(self.root), "--dry-run", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(self.read_raw(), original)

    def test_refusal_exits_non_zero(self):
        self.assertEqual(mr.main(["--root", str(self.root), "--json"]), 1)

    def test_worklog_dir_flag_targets_an_alternate_directory(self):
        alt = self.root / "alt-worklog"
        alt.mkdir()
        (alt / "scheduled-prompts.json").write_text('{"entries": []}', encoding="utf-8")

        code = mr.main(["--worklog-dir", str(alt), "--json"])

        self.assertEqual(code, 0)
        stored = json.loads((alt / "scheduled-prompts.json").read_text(encoding="utf-8"))
        self.assertEqual(len(stored["entries"]), 3)
        self.assertFalse(self.config_path.exists())

    def test_human_output_lists_each_routine(self):
        self.write_config({"entries": []})
        report = mr.reconcile(root=self.root)
        rendered = mr.render_report(report)
        for routine_id in ("/skill:test", "/skill:standup", "/skill:refactor"):
            self.assertIn(routine_id, rendered)
        self.assertIn("07:00", rendered)
        self.assertIn("high", rendered)

    def test_human_output_for_a_refusal_names_the_remedy(self):
        report = mr.reconcile(root=self.root)
        rendered = mr.render_report(report)
        self.assertIn("config-missing", rendered)
        self.assertIn("Remedy", rendered)


if __name__ == "__main__":
    unittest.main()
