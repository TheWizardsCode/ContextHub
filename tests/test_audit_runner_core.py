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
    _assemble_issue_report,
    _assemble_child_audit_report,
    _assemble_project_report,
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
