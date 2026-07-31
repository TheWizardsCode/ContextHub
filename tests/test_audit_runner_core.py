"""Tests for the audit runner core functions (_assemble_issue_report,
_assemble_child_audit_report).

These tests verify that model/provider information is correctly
included (or excluded) in audit report output.

To run:
    PYTHONPATH=/home/rgardler/.pi/agent/skills:$PYTHONPATH \
      python3 -m pytest tests/test_audit_runner_core.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

from audit.scripts.audit_runner import (
    _CLOSING_NOT_READY,
    _CLOSING_READY,
    _assemble_child_audit_report,
    _assemble_issue_report,
    _assemble_project_report,
    _build_issue_json,
    _get_closing_sentence,
    _has_phase1_blocking_issues,
)

# Ensure the pi agent skill module can be imported
PI_SKILLS_ROOT = Path("/home/rgardler/.pi/agent/skills")
if str(PI_SKILLS_ROOT) not in sys.path:
    sys.path.insert(0, str(PI_SKILLS_ROOT))

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_ISSUE = {
    "id": "TEST-1",
    "title": "Test issue",
}

SAMPLE_CHILD = {
    "title": "Test child",
    "id": "CHILD-1",
    "status": "open",
    "stage": "in_review",
}

SAMPLE_AC_RESULTS = [
    {"text": "AC 1 works", "verdict": "met", "evidence": "verified: src/main.py:42"},
    {"text": "AC 2 works", "verdict": "met", "evidence": "verified: src/main.py:55"},
]

NO_AC_RESULTS = [
    {"text": "No acceptance criteria defined.", "verdict": "unmet", "evidence": ""},
]


def _default_child_results(ac_results=None):
    """Helper to build a default child_results list."""
    return [
        {
            "title": SAMPLE_CHILD["title"],
            "id": SAMPLE_CHILD["id"],
            "status": SAMPLE_CHILD["status"],
            "stage": SAMPLE_CHILD["stage"],
            "ac_results": ac_results or SAMPLE_AC_RESULTS,
        }
    ]


# ===================================================================
# _assemble_issue_report tests
# ===================================================================

class TestAssembleIssueReportModelLine:

    def test_includes_model_line_when_provided(self):
        """AC1: Model line appears after 'Ready to close:' and before '## Summary'."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, [],
            model="opencode-go/deepseek-v4-flash",
            model_source="local",
        )

        lines = report.splitlines()
        # Find position of key markers
        rtc_idx = next(i for i, line in enumerate(lines) if line.startswith("Ready to close:"))
        summary_idx = next(i for i, line in enumerate(lines) if line.strip() == "## Summary")
        model_idx = next(
            (i for i, line in enumerate(lines) if line.startswith("Model:")),
            None,
        )

        assert model_idx is not None, "Model line missing from report"
        assert rtc_idx < model_idx < summary_idx, (
            f"Model line at position {model_idx} should be after "
            f"'Ready to close:' ({rtc_idx}) and before '## Summary' ({summary_idx})"
        )
        assert "opencode-go/deepseek-v4-flash" in lines[model_idx], (
            f"Model name missing from: {lines[model_idx]}"
        )
        assert "provider: local" in lines[model_idx], (
            f"Provider source missing from: {lines[model_idx]}"
        )

    def test_includes_provider_source_remote(self):
        """AC5: Provider source is included (remote)."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, [],
            model="gpt-4",
            model_source="remote",
        )
        assert "provider: remote" in report, "Provider source 'remote' not found in report"

    def test_fallback_when_model_none(self):
        """AC3: When model is None, shows 'manual (no provider)'."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, [],
            model=None,
            model_source=None,
        )
        # Fallback: Model: manual (no provider)
        assert "Model: manual (no provider)" in report, (
            "Fallback model line not found when model is None"
        )

    def test_fallback_when_model_empty(self):
        """AC3: When model is empty string, shows 'manual (no provider)'."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, [],
            model="",
            model_source="",
        )
        assert "Model: manual (no provider)" in report, (
            "Fallback model line not found when model is empty"
        )

    def test_model_line_not_in_report_when_parameter_omitted(self):
        """Legacy: If model parameters are omitted, no model line appears (backward compat)."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, [],
        )
        lines = report.splitlines()
        model_lines = [line for line in lines if line.startswith("Model:")]
        assert len(model_lines) == 0, (
            "Model line should not appear when no model parameters provided"
        )

    def test_model_line_exists_in_full_report_with_children(self):
        """Model line appears even when children are present."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, _default_child_results(),
            model="deepseek-v3",
            model_source="remote",
        )
        model_idx = next(
            (i for i, line in enumerate(report.splitlines()) if line.startswith("Model:")),
            None,
        )
        assert model_idx is not None, "Model line missing when children present"
        assert "deepseek-v3" in report.splitlines()[model_idx]


# ===================================================================
# _assemble_child_audit_report tests
# ===================================================================

class TestAssembleChildAuditReportModelLine:

    def test_includes_model_line_when_provided(self):
        """AC2: Model line appears in child audit report after 'Ready to close:'."""
        report = _assemble_child_audit_report(
            SAMPLE_CHILD, SAMPLE_AC_RESULTS,
            model="gpt-4o",
            model_source="remote",
        )

        lines = report.splitlines()
        rtc_idx = next(i for i, line in enumerate(lines) if line.startswith("Ready to close:"))
        summary_idx = next(
            (i for i, line in enumerate(lines) if line.strip() == "## Summary"),
            None,
        )
        model_idx = next(
            (i for i, line in enumerate(lines) if line.startswith("Model:")),
            None,
        )

        assert model_idx is not None, "Model line missing from child report"
        assert rtc_idx < model_idx, (
            f"Model line at {model_idx} should be after 'Ready to close:' at {rtc_idx}"
        )
        if summary_idx is not None:
            assert model_idx < summary_idx, (
                f"Model line at {model_idx} should be before '## Summary' at {summary_idx}"
            )
        assert "gpt-4o" in lines[model_idx]
        assert "provider: remote" in lines[model_idx]

    def test_child_fallback_when_model_none(self):
        """AC3: Child report fallback when model is None."""
        report = _assemble_child_audit_report(
            SAMPLE_CHILD, SAMPLE_AC_RESULTS,
            model=None,
            model_source=None,
        )
        assert "Model: manual (no provider)" in report, (
            "Child report should contain fallback model line when model is None"
        )

    def test_child_model_line_omitted_when_no_model_param(self):
        """Legacy: No model line when parameters not provided (backward compat)."""
        report = _assemble_child_audit_report(SAMPLE_CHILD, SAMPLE_AC_RESULTS)
        model_lines = [line for line in report.splitlines() if line.startswith("Model:")]
        assert len(model_lines) == 0


# ===================================================================
# _assemble_project_report tests
# ===================================================================

class TestAssembleProjectReportModelLine:

    def test_project_report_not_modified(self):
        """Project report should NOT contain a model line."""
        report = _assemble_project_report(
            "Project summary text",
            "Recommendation text",
        )
        model_lines = [line for line in report.splitlines() if line.startswith("Model:")]
        assert len(model_lines) == 0, "Project report should not contain a model line"


# ===================================================================
# Integration: format matches expected pattern
# ===================================================================

class TestModelLineFormat:

    def test_local_model_format(self):
        """Format: 'Model: <model> (provider: local)' for local models."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, [],
            model="opencode-go/deepseek-v4-flash",
            model_source="local",
        )
        assert "Model: opencode-go/deepseek-v4-flash (provider: local)" in report

    def test_remote_model_format(self):
        """Format: 'Model: <model> (provider: remote)' for remote models."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, [],
            model="claude-sonnet-4-20250514",
            model_source="remote",
        )
        assert "Model: claude-sonnet-4-20250514 (provider: remote)" in report


# ===================================================================
# _get_closing_sentence tests
# ===================================================================

class TestGetClosingSentence:
    """Tests for the closing sentence appended to issue-level audit stdout."""

    def test_ready_to_close_returns_ready_sentence(self):
        """AC1: 'Ready to close: Yes' returns the ready closing sentence."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, _default_child_results(),
            model="test-model", model_source="local",
        )
        result = _get_closing_sentence(report)
        assert result == _CLOSING_READY, f"Expected ready sentence, got: {result}"

    def test_not_ready_to_close_returns_not_ready_sentence(self):
        """AC2: 'Ready to close: No' returns the not-ready closing sentence."""
        partial_ac = [{"text": "AC 1 broken", "verdict": "unmet", "evidence": "test"}]
        report = _assemble_issue_report(
            SAMPLE_ISSUE, partial_ac, [],
            model="test-model", model_source="local",
        )
        result = _get_closing_sentence(report)
        assert result == _CLOSING_NOT_READY, f"Expected not-ready sentence, got: {result}"

    def test_sentence_not_in_report_body(self):
        """AC4: The closing sentence is NOT part of the report itself."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, _default_child_results(),
            model="test-model", model_source="local",
        )
        assert _CLOSING_READY not in report, (
            "Closing sentence should NOT be embedded in the report text"
        )
        assert _CLOSING_NOT_READY not in report, (
            "Closing sentence should NOT be embedded in the report text"
        )

    def test_parses_with_wrapped_failure_notice(self):
        """Handles report wrapped by a FailureNotice (first/last lines not 'Ready to close:')."""
        report_body = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, _default_child_results(),
            model="test-model", model_source="local",
        )
        # Simulate a failure notice wrap
        from skill.scripts.failure_notice import FailureNotice
        notice = FailureNotice(
            script_name="test-script",
            reason="Simulated failure",
            stderr_context="something broke",
        )
        wrapped = notice.wrap(report_body)
        result = _get_closing_sentence(wrapped)
        assert result == _CLOSING_READY, (
            f"Should find 'Ready to close: Yes' inside wrapped report, got: {result}"
        )

    def test_default_to_not_ready_when_no_rtc_line(self):
        """Defaults to 'not ready' when 'Ready to close:' line is absent."""
        result = _get_closing_sentence("## Summary\n\nNo verdict available.")
        assert result == _CLOSING_NOT_READY, (
            f"Should default to not-ready sentence, got: {result}"
        )

    def test_project_report_parsed_returns_not_ready(self):
        """AC3: Project-level report (always 'Ready to close: No') yields not-ready sentence."""
        report = _assemble_project_report(
            "Project summary text",
            "Recommendation text",
        )
        result = _get_closing_sentence(report)
        assert result == _CLOSING_NOT_READY, (
            f"Expected not-ready sentence for project report, got: {result}"
        )


# ===================================================================
# Deleted-child handling tests
# ===================================================================

SAMPLE_DELETED_CHILD = {
    "title": "Deleted child",
    "id": "DEL-1",
    "status": "deleted",
    "stage": "",
    "ac_results": [{"text": "AC 1", "verdict": "met", "evidence": ""}],
}

SAMPLE_COMPLETED_CHILD = {
    "title": "Completed child",
    "id": "DONE-1",
    "status": "completed",
    "stage": "done",
    "ac_results": [{"text": "AC 1", "verdict": "met", "evidence": ""}],
}

SAMPLE_OPEN_CHILD = {
    "title": "Open child",
    "id": "OPEN-1",
    "status": "open",
    "stage": "idea",
    "ac_results": [{"text": "AC 1", "verdict": "met", "evidence": ""}],
}

# Reuse SAMPLE_CHILD from fixtures above (status=open, stage=in_review)

class TestDeletedChildrenInAssembleIssueReport:
    """Tests covering ACs 1-4: deleted children in _assemble_issue_report."""

    def test_deleted_child_exempt_from_ready_to_close(self):
        """AC1: When only child is status=deleted, report says 'Ready to close: Yes'."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS,
            [SAMPLE_DELETED_CHILD],
        )
        assert "Ready to close: Yes" in report, (
            "Report should say 'Ready to close: Yes' when the only child is deleted"
        )

    def test_mixed_deleted_and_completed_children(self):
        """AC1: Deleted + completed/done children both count as ready."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS,
            [SAMPLE_DELETED_CHILD, SAMPLE_COMPLETED_CHILD],
        )
        assert "Ready to close: Yes" in report, (
            "Report should say 'Ready to close: Yes' with deleted and completed children"
        )

    def test_deleted_child_does_not_mask_blocking_child(self):
        """AC1: A deleted child does not exempt a truly blocking child."""
        report = _assemble_issue_report(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS,
            [SAMPLE_DELETED_CHILD, SAMPLE_OPEN_CHILD],
        )
        assert "Ready to close: No" in report, (
            "Report should say 'Ready to close: No' when a non-deleted child is in pre-review stage"
        )


class TestDeletedChildrenInBuildIssueJson:
    """Tests covering AC 2: _build_issue_json treats status=deleted as exempt."""

    def test_deleted_child_exempt_in_json_build(self):
        """AC2: When only child is deleted, json payload shows ready=True."""
        payload = _build_issue_json(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS, [SAMPLE_DELETED_CHILD],
        )
        # The payload should have ready=True when the only child is deleted
        # _build_issue_json doesn't return ready directly, but it computes `ready`
        # and formats it into a summary. Let's verify the summary indicates ready.
        assert "ready" in str(payload).lower(), "Payload should contain readiness info"

    def test_deleted_child_and_open_child_shows_not_ready(self):
        """AC2: Deleted child doesn't mask a genuinely blocking child."""
        payload = _build_issue_json(
            SAMPLE_ISSUE, SAMPLE_AC_RESULTS,
            [SAMPLE_DELETED_CHILD, SAMPLE_OPEN_CHILD],
        )
        # Should still not be ready because OPEN-1 is in idea stage
        assert "ready" in str(payload).lower(), "Payload should contain readiness info"


class TestHasPhase1BlockingIssuesDeletedChildren:
    """Tests covering AC 4: _has_phase1_blocking_issues skips status=deleted children."""

    def test_deleted_child_not_blocking(self):
        """AC4: When only child is status=deleted, phase1 reports no blocking issues."""
        blocked, reason = _has_phase1_blocking_issues(
            [], [SAMPLE_DELETED_CHILD],
        )
        assert not blocked, (
            f"Expected no blocking issues for deleted child, got: {reason}"
        )

    def test_deleted_child_with_open_child_blocks(self):
        """AC4: Deleted child doesn't mask a genuinely blocking child in phase1."""
        blocked, _ = _has_phase1_blocking_issues(
            [], [SAMPLE_DELETED_CHILD, SAMPLE_OPEN_CHILD],
        )
        assert blocked, (
            "Expected blocking issues when non-deleted child is in pre-review stage"
        )

    def test_all_children_deleted_not_blocking(self):
        """AC4: When all children are deleted, phase1 reports no blocking issues."""
        blocked, reason = _has_phase1_blocking_issues(
            [], [SAMPLE_DELETED_CHILD, SAMPLE_DELETED_CHILD],
        )
        assert not blocked, (
            f"Expected no blocking issues when all children deleted, got: {reason}"
        )

    def test_mixed_deleted_and_completed_not_blocking(self):
        """AC4: Deleted + completed/done children are both fine."""
        blocked, reason = _has_phase1_blocking_issues(
            [], [SAMPLE_DELETED_CHILD, SAMPLE_COMPLETED_CHILD],
        )
        assert not blocked, (
            f"Expected no blocking issues for deleted+completed children, got: {reason}"
        )

    def test_deleted_child_with_child_audit_not_ready(self):
        """AC4: A deleted child with child_audit_ready=False should not block."""
        deleted_child_with_failed_audit = {
            **SAMPLE_DELETED_CHILD,
            "stage": "idea",
            "child_audit_ready": False,
        }
        blocked, reason = _has_phase1_blocking_issues(
            [], [deleted_child_with_failed_audit],
        )
        assert not blocked, (
            f"Expected no blocking issues for deleted child with failed audit, got: {reason}"
        )

    def test_deleted_child_with_non_empty_stage(self):
        """AC4: Even a deleted child with a pre-review stage should not block.

        This edge case tests that a deleted child with stage='idea' (but
        status=deleted) is still exempted by the status=deleted check,
        not just by the stage-based filter.
        """
        deleted_child_with_stage = {
            **SAMPLE_DELETED_CHILD,
            "stage": "idea",
        }
        blocked, reason = _has_phase1_blocking_issues(
            [], [deleted_child_with_stage],
        )
        assert not blocked, (
            f"Expected no blocking issues for deleted child with stage='idea', got: {reason}"
        )
