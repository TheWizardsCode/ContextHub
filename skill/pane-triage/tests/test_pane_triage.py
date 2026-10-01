#!/usr/bin/env python3
"""
Offline fixture tests for the pane-triage skill core module.

These tests exercise the skill's *logic* against fixture data that models the
JSON emitted by the shared pane-close bridge CLI
(``packages/herdr/dist/pane-close-cli.js --json``). They do **not** invoke the
shared classifier themselves — the classification (`close` / `reasonCode`) is
produced by the bridge and consumed here. The tests assert that the skill
faithfully maps that shared output into its report, recommendation, and
approval-gated closure behaviour.

Coverage maps to the work-item acceptance criteria
(``WL-0MUJMXVPO0016DZM``):

- AC1  workspace resolution (env → ``herdr pane current`` fallback)
- AC2  idle classification via shared classifier (bridge output)
- AC3  Idle/Active tables with work-item id + ``needsProducerReview``
- AC4  last-20-lines log tail per idle pane
- AC5  "Recommended to close" excludes invoking pane and review-pending
- AC6  approval gating: no approval → zero close calls
- AC7  re-verify before close drops panes that became active
- AC8  the above fixtures cover classification, marker-mid-message,
      work-item-id parsing, review mapping, recommendation rules,
      approval gating
"""

import json
import os
import sys
import unittest
from unittest import mock

# Make the skill's scripts importable regardless of the invocation directory.
_SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if os.path.join(_SKILL_DIR, "scripts") not in sys.path:
    sys.path.insert(0, os.path.join(_SKILL_DIR, "scripts"))

from pane_triage import (
    BridgeError,
    build_report,
    classify_via_bridge,
    close_selected_panes,
    parse_workspace_id,
    recommend_to_close,
    render_log_tail,
    resolve_workspace,
    select_approval,
)

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def _pane(
    pane_id="wp:p1",
    title="Downtime triggered plan Foo - WL-0ABC123",
    item_id="WL-0ABC123",
    workspace="w1",
    tab="wp:t1",
    kind="plan",
    close=False,
    reason_code="active",
    success=True,
    needs_producer_review=False,
    is_invoking=False,
):
    """Build one bridge-output pane record."""
    return {
        "paneId": pane_id,
        "paneTitle": title,
        "itemId": item_id,
        "workspaceId": workspace,
        "tabId": tab,
        "kind": kind,
        "close": close,
        "reasonCode": reason_code,
        "reasonSnapshot": {
            "kind": kind,
            "needsProducerReview": needs_producer_review,
            "isInvokingPane": is_invoking,
        },
        "success": success,
    }


def _bridge_doc(panes, close_count=None):
    """Build a full bridge JSON document."""
    return {
        "panes": panes,
        "evaluated": len(panes),
        "closeCount": close_count if close_count is not None
        else sum(1 for p in panes if p.get("close")),
        "failureCount": 0,
        "dryRun": True,
    }


# ---------------------------------------------------------------------------
# AC1 — workspace resolution
# ---------------------------------------------------------------------------

class TestParseWorkspaceId(unittest.TestCase):
    def test_reads_herdr_workspace_id_env(self):
        self.assertEqual(
            parse_workspace_id({"HERDR_WORKSPACE_ID": "w2V"}), "w2V"
        )

    def test_returns_none_when_env_absent(self):
        self.assertIsNone(parse_workspace_id({}))

    def test_blank_env_is_treated_as_absent(self):
        self.assertIsNone(parse_workspace_id({"HERDR_WORKSPACE_ID": "  "}))


class TestResolveWorkspace(unittest.TestCase):
    def test_prefers_env_over_herdr(self):
        result = resolve_workspace(
            env={"HERDR_WORKSPACE_ID": "w2V"},
            run_herdr_current=lambda: "w9Z",
        )
        self.assertEqual(result, "w2V")

    def test_falls_back_to_herdr_pane_current(self):
        raw = json.dumps(
            {"id": "cli:pane:current", "result": {"pane": {"workspace_id": "w3G"}}}
        )
        result = resolve_workspace(env={}, run_herdr_current=lambda: raw)
        self.assertEqual(result, "w3G")

    def test_returns_none_when_neither_available(self):
        with self.assertRaises(BridgeError):
            resolve_workspace(env={}, run_herdr_current=lambda: "not json")


# ---------------------------------------------------------------------------
# AC2/AC3 — classification & report tables
# ---------------------------------------------------------------------------

class TestBuildReport(unittest.TestCase):
    def test_idle_and_active_tables_split_by_shared_close_flag(self):
        panes = [
            _pane(pane_id="wp:p1", close=True, reason_code="marker",
                  item_id="WL-0AAA111"),
            _pane(pane_id="wp:p2", close=False, reason_code="active",
                  item_id="WL-0BBB222", title="Downtime triggered intake Bar - WL-0BBB222"),
        ]
        report = build_report(panes, invoking_pane_id="wp:pX")
        self.assertIn("Idle", report)
        self.assertIn("Active", report)
        # Idle table carries the work-item id.
        self.assertIn("WL-0AAA111", report)
        # Active table carries the other work-item id.
        self.assertIn("WL-0BBB222", report)

    def test_report_includes_tab_column(self):
        panes = [_pane(pane_id="wp:p1", tab="wp:t9", close=True,
                       reason_code="marker")]
        report = build_report(panes, invoking_pane_id="wp:pX")
        self.assertIn("Tab", report)
        self.assertIn("wp:t9", report)

    def test_report_includes_needs_producer_review_value(self):
        panes = [
            _pane(pane_id="wp:p1", close=True, reason_code="marker",
                  needs_producer_review=True, item_id="WL-0RVW333"),
        ]
        report = build_report(panes, invoking_pane_id="wp:pX")
        self.assertIn("WL-0RVW333", report)
        # The review flag must be surfaced so the producer can decide.
        self.assertRegex(report, r"(?i)needs.?producer.?review")

    def test_marker_mid_message_stays_active(self):
        # The shared classifier emits close=false/'active' for a mid-message
        # marker; the skill must keep it in Active.
        panes = [_pane(pane_id="wp:p1", close=False, reason_code="active")]
        report = build_report(panes, invoking_pane_id="wp:pX")
        idle_section, active_section = _split_sections(report)
        self.assertNotIn("wp:p1", idle_section)
        self.assertIn("wp:p1", active_section)

    def test_implement_pane_is_active_not_idle(self):
        panes = [_pane(pane_id="wp:p1", close=False, reason_code="implement",
                       kind="implement")]
        report = build_report(panes, invoking_pane_id="wp:pX")
        idle_section, _ = _split_sections(report)
        self.assertNotIn("wp:p1", idle_section)


def _split_sections(report):
    """Split a rendered report into (idle_section, active_section)."""
    idle_start = report.index("## Idle")
    active_start = report.index("## Active")
    return report[idle_start:active_start], report[active_start:]


# ---------------------------------------------------------------------------
# AC4 — log tail rendering
# ---------------------------------------------------------------------------

class TestRenderLogTail(unittest.TestCase):
    def test_prints_last_20_lines_under_heading(self):
        lines = [f"line {i}" for i in range(1, 31)]
        rendered = render_log_tail("My Pane", needs_review=False, lines=lines)
        self.assertIn("My Pane Needs Review False", rendered)
        # Only the last 20 lines appear.
        self.assertIn("line 11", rendered)
        self.assertIn("line 30", rendered)
        self.assertNotIn("line 10\n", rendered)

    def test_heading_reports_true_for_review_pending(self):
        rendered = render_log_tail("My Pane", needs_review=True, lines=["x"])
        self.assertIn("My Pane Needs Review True", rendered)


# ---------------------------------------------------------------------------
# AC5 — recommendation rules
# ---------------------------------------------------------------------------

class TestRecommendToClose(unittest.TestCase):
    def test_recommends_idle_pane(self):
        panes = [_pane(pane_id="wp:p1", close=True, reason_code="marker")]
        recs = recommend_to_close(panes, invoking_pane_id="wp:pX")
        self.assertEqual([p["paneId"] for p in recs], ["wp:p1"])

    def test_excludes_the_invoking_pane(self):
        panes = [_pane(pane_id="wp:pX", close=True, reason_code="marker",
                       is_invoking=True)]
        recs = recommend_to_close(panes, invoking_pane_id="wp:pX")
        self.assertEqual(recs, [])

    def test_excludes_review_pending_even_when_idle(self):
        panes = [_pane(pane_id="wp:p1", close=True, reason_code="marker",
                       needs_producer_review=True)]
        recs = recommend_to_close(panes, invoking_pane_id="wp:pX")
        self.assertEqual(recs, [])

    def test_excludes_active_panes(self):
        panes = [_pane(pane_id="wp:p1", close=False, reason_code="active")]
        recs = recommend_to_close(panes, invoking_pane_id="wp:pX")
        self.assertEqual(recs, [])

    def test_invoking_pane_never_recommended_even_if_not_flagged(self):
        # Defensive: the invoking pane is excluded by id regardless of the
        # classifier's isInvokingPane flag.
        panes = [_pane(pane_id="wp:pX", close=True, reason_code="marker",
                       is_invoking=False)]
        recs = recommend_to_close(panes, invoking_pane_id="wp:pX")
        self.assertEqual(recs, [])


# ---------------------------------------------------------------------------
# AC6 — approval gating
# ---------------------------------------------------------------------------

class TestSelectApproval(unittest.TestCase):
    def test_no_closes_nothing(self):
        self.assertEqual(
            select_approval("no", ["wp:p1", "wp:p2"]), []
        )

    def test_ambiguous_input_closes_nothing(self):
        self.assertEqual(select_approval("maybe", ["wp:p1"]), [])
        self.assertEqual(select_approval("", ["wp:p1"]), [])

    def test_yes_selects_all_recommended(self):
        self.assertEqual(
            select_approval("yes", ["wp:p1", "wp:p2"]), ["wp:p1", "wp:p2"]
        )

    def test_select_parses_indices(self):
        self.assertEqual(
            select_approval("select 1,3", ["wp:p1", "wp:p2", "wp:p3"]),
            ["wp:p1", "wp:p3"],
        )

    def test_select_ignores_out_of_range(self):
        self.assertEqual(
            select_approval("select 9", ["wp:p1"]), []
        )


class TestNoApprovalMeansZeroCloseCalls(unittest.TestCase):
    def test_no_approval_never_calls_close(self):
        close_calls = []

        def fake_close(pane_id):
            close_calls.append(pane_id)
            return True

        result = close_selected_panes(
            approved_pane_ids=[],
            current_panes=[_pane(close=True, reason_code="marker")],
            close_fn=fake_close,
            list_panes_fn=lambda: _bridge_doc([_pane(close=True)]),
        )
        self.assertEqual(close_calls, [])
        self.assertEqual(result["closed"], [])


# ---------------------------------------------------------------------------
# AC7 — re-verify before close
# ---------------------------------------------------------------------------

class TestCloseSelectedPanes(unittest.TestCase):
    def test_reverifies_and_drops_pane_that_became_active(self):
        calls = []

        # Before approval the pane was idle; on re-verify it is active.
        reverify_doc = _bridge_doc([
            _pane(pane_id="wp:p1", close=False, reason_code="active"),
        ])
        result = close_selected_panes(
            approved_pane_ids=["wp:p1"],
            current_panes=[_pane(pane_id="wp:p1", close=True, reason_code="marker")],
            close_fn=lambda pid: calls.append(pid) or True,
            list_panes_fn=lambda: reverify_doc,
        )
        self.assertEqual(calls, [])
        self.assertEqual(result["closed"], [])
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(result["skipped"][0]["paneId"], "wp:p1")

    def test_closes_pane_still_idle_on_reverify(self):
        calls = []
        reverify_doc = _bridge_doc([
            _pane(pane_id="wp:p1", close=True, reason_code="marker"),
        ])
        result = close_selected_panes(
            approved_pane_ids=["wp:p1"],
            current_panes=[_pane(pane_id="wp:p1", close=True, reason_code="marker")],
            close_fn=lambda pid: calls.append(pid) or True,
            list_panes_fn=lambda: reverify_doc,
        )
        self.assertEqual(calls, ["wp:p1"])
        self.assertEqual(result["closed"], ["wp:p1"])

    def test_never_closes_invoking_pane(self):
        calls = []
        reverify_doc = _bridge_doc([
            _pane(pane_id="wp:pX", close=True, reason_code="marker"),
        ])
        result = close_selected_panes(
            approved_pane_ids=["wp:pX"],
            current_panes=[_pane(pane_id="wp:pX", close=True, reason_code="marker")],
            close_fn=lambda pid: calls.append(pid) or True,
            list_panes_fn=lambda: reverify_doc,
            invoking_pane_id="wp:pX",
        )
        self.assertEqual(calls, [])
        self.assertEqual(result["closed"], [])


# ---------------------------------------------------------------------------
# Bridge integration (shared classifier, not reimplemented)
# ---------------------------------------------------------------------------

class TestClassifyViaBridge(unittest.TestCase):
    def test_parses_bridge_json(self):
        payload = json.dumps(_bridge_doc([_pane(close=True)]))
        with mock.patch("pane_triage._run_bridge", return_value=payload):
            panes = classify_via_bridge(workspace="w1")
        self.assertEqual(len(panes), 1)
        self.assertTrue(panes[0]["close"])

    def test_raises_bridge_error_on_unparseable_output(self):
        with mock.patch("pane_triage._run_bridge", return_value="not json"), \
                self.assertRaises(BridgeError):
            classify_via_bridge(workspace="w1")

    def test_workspace_is_passed_to_bridge(self):
        captured = {}

        def fake_bridge(args):
            captured["args"] = args
            return json.dumps(_bridge_doc([_pane(close=True)]))

        with mock.patch("pane_triage._run_bridge", side_effect=fake_bridge):
            classify_via_bridge(workspace="w7X")
        self.assertIn("--workspace", captured["args"])
        self.assertIn("w7X", captured["args"])


if __name__ == "__main__":
    unittest.main()
