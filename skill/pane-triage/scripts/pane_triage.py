"""
pane_triage — core logic for the pane-triage skill.

This module is the approval-gated, workspace-scoped manual complement to the
automatic pane-close reaper (``WL-0MUJW9EEP009Q0V3``). It never reimplements
idle-state logic: classification is delegated to the shared classifier via the
ContextHub bridge CLI (``packages/herdr/dist/pane-close-cli.js --json``), which
imports ``classifySession`` / ``extractFinalAssistantText`` verbatim.

Responsibilities:

- ``resolve_workspace``      — env ``HERDR_WORKSPACE_ID`` → ``herdr pane current``
- ``classify_via_bridge``    — shell out to the shared bridge, parse JSON
- ``build_report``           — render Idle/Active tables + work-item context
- ``render_log_tail``        — last-20-lines tail per idle pane
- ``recommend_to_close``     — never-close guards (invoking pane, review-pending)
- ``select_approval``        — parse the producer's yes/select/no response
- ``close_selected_panes``   — re-verify idle immediately before closing

The module is import-safe and side-effect free; the CLI wrapper
(``scripts/pane-triage.py``) owns argv parsing and interactive prompts.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any

__all__ = [
    "BridgeError",
    "build_report",
    "classify_via_bridge",
    "close_selected_panes",
    "parse_workspace_id",
    "recommend_to_close",
    "render_log_tail",
    "resolve_workspace",
    "select_approval",
]

# Default bridge command. The ContextHub bridge accepts ``--json`` and the
# reaper flags. Overridable so tests can inject a fake and operators can point
# at a non-standard checkout.
DEFAULT_BRIDGE_COMMAND = os.path.join(
    os.environ.get("CONTEXTHUB_DIR", os.path.expanduser("~/projects/ContextHub")),
    "packages",
    "herdr",
    "dist",
    "pane-close-cli.js",
)

# Number of log lines to show per idle pane (AC4).
LOG_TAIL_LINES = 20

# Bridge command timeout (seconds). Generous: the bridge reads many session
# files and may call ``wl show`` per pane.
BRIDGE_TIMEOUT_S = 120


class BridgeError(RuntimeError):
    """Raised when the shared pane-close bridge cannot be invoked or parsed.

    Fail-closed: callers must not proceed to closure when the bridge fails,
    because classification evidence is unavailable.
    """


# ---------------------------------------------------------------------------
# AC1 — workspace resolution
# ---------------------------------------------------------------------------

def parse_workspace_id(env: Mapping[str, str]) -> str | None:
    """Return the workspace id from ``HERDR_WORKSPACE_ID``, or ``None``.

    Blank/whitespace values are treated as absent so a stray empty export does
    not shadow the ``herdr pane current`` fallback.
    """
    value = (env.get("HERDR_WORKSPACE_ID") or "").strip()
    return value or None


def _extract_json(raw: str) -> Any:
    """Parse the first JSON value in *raw*, tolerating leading log lines."""
    starts = [i for i in (raw.find("{"), raw.find("[")) if i >= 0]
    if not starts:
        raise BridgeError(f"no JSON found in output: {raw[:200]!r}")
    try:
        return json.loads(raw[min(starts):])
    except json.JSONDecodeError as exc:
        raise BridgeError(f"invalid JSON in output: {exc}") from exc


def resolve_workspace(
    env: Mapping[str, str] | None = None,
    run_herdr_current: Callable[[], str] | None = None,
) -> str:
    """Resolve the invoking workspace id (AC1).

    Precedence:
      1. ``HERDR_WORKSPACE_ID`` environment variable.
      2. ``herdr pane current`` → ``result.pane.workspace_id``.

    Raises ``BridgeError`` when neither yields a workspace id, so the skill
    fails closed rather than reporting on every workspace.
    """
    env = env if env is not None else os.environ
    from_env = parse_workspace_id(env)
    if from_env:
        return from_env

    runner = run_herdr_current or _run_herdr_current
    try:
        raw = runner()
    except Exception as exc:
        raise BridgeError(f"`herdr pane current` failed: {exc}") from exc
    payload = _extract_json(raw)
    pane = ((payload or {}).get("result") or {}).get("pane") or {}
    workspace_id = pane.get("workspace_id") or pane.get("workspaceId")
    if not workspace_id:
        raise BridgeError(
            "could not resolve workspace id from HERDR_WORKSPACE_ID or "
            "`herdr pane current`"
        )
    return str(workspace_id)


def _run_herdr_current() -> str:
    """Run ``herdr pane current`` and return stdout (fail-closed)."""
    proc = subprocess.run(
        ["herdr", "pane", "current"],
        capture_output=True,
        text=True,
        timeout=BRIDGE_TIMEOUT_S,
        check=False,
    )
    if proc.returncode != 0:
        raise BridgeError(
            f"`herdr pane current` exited {proc.returncode}: {proc.stderr.strip()}"
        )
    return proc.stdout


# ---------------------------------------------------------------------------
# AC2 — classification via the shared bridge (never reimplemented)
# ---------------------------------------------------------------------------

def _run_bridge(args: Sequence[str]) -> str:
    """Invoke the shared bridge CLI and return stdout.

    The bridge is the only sanctioned path to the shared classifier. It is
    invoked with ``--json`` so stdout is a single machine-parseable document.
    """
    command = os.environ.get("PANE_TRIAGE_BRIDGE", DEFAULT_BRIDGE_COMMAND)
    if not os.path.exists(command):
        raise BridgeError(
            f"pane-close bridge not found at {command!r}; build ContextHub "
            "(`cd packages/herdr && npm run build`) or set PANE_TRIAGE_BRIDGE"
        )
    proc = subprocess.run(
        ["node", command, *args],
        capture_output=True,
        text=True,
        timeout=BRIDGE_TIMEOUT_S,
        check=False,
    )
    if proc.returncode != 0:
        raise BridgeError(
            f"pane-close bridge exited {proc.returncode}: {proc.stderr.strip()}"
        )
    return proc.stdout


def classify_via_bridge(
    workspace: str | None = None,
    invoking_pane_id: str | None = None,
    extra_args: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """Return per-pane classification records from the shared bridge (AC2).

    The bridge runs the reaper in ``--dry-run`` mode (no closure) and emits
    JSON: ``{panes: [{paneId, paneTitle, itemId, workspaceId, kind, close,
    reasonCode, reasonSnapshot, success}], ...}``.

    Raises ``BridgeError`` on invocation or parse failure (fail-closed).
    """
    args = ["--json", "--dry-run"]
    if workspace:
        args += ["--workspace", workspace]
    if extra_args:
        args += list(extra_args)

    raw = _run_bridge(args)
    payload = _extract_json(raw)
    if not isinstance(payload, dict) or not isinstance(payload.get("panes"), list):
        raise BridgeError("bridge output missing a `panes` array")
    return [p for p in payload["panes"] if isinstance(p, dict)]


def _is_invoking(pane: Mapping[str, Any], invoking_pane_id: str | None) -> bool:
    """Whether *pane* is the invoking pane (by id or classifier flag)."""
    if invoking_pane_id and pane.get("paneId") == invoking_pane_id:
        return True
    snapshot = pane.get("reasonSnapshot") or {}
    return bool(snapshot.get("isInvokingPane"))


def _needs_review(pane: Mapping[str, Any]) -> bool:
    """Whether the pane's work item is review-pending (never close)."""
    snapshot = pane.get("reasonSnapshot") or {}
    return bool(snapshot.get("needsProducerReview"))


# ---------------------------------------------------------------------------
# AC3 — report rendering
# ---------------------------------------------------------------------------

def _md_table(headers: Sequence[str], rows: Iterable[Sequence[str]]) -> str:
    """Render a GitHub-flavoured markdown table."""
    out = ["| " + " | ".join(headers) + " |"]
    out.append("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        out.append("| " + " | ".join(str(c) for c in row) + " |")
    return "\n".join(out)


def build_report(
    panes: Sequence[Mapping[str, Any]],
    invoking_pane_id: str | None,
) -> str:
    """Render the Idle/Active report with work-item context (AC3).

    Sections:
      - ``## Idle``   — panes the shared classifier flagged ``close=true``
      - ``## Active`` — all other panes, with the classifier reason
    """
    idle = [p for p in panes if p.get("close")]
    active = [p for p in panes if not p.get("close")]

    lines: list[str] = []
    lines.append(f"# Pane Triage — {len(panes)} pane(s) evaluated")
    lines.append("")
    lines.append("## Idle")
    lines.append("")
    if idle:
        lines.append(
            _md_table(
                ["Pane", "Tab", "Title", "Work Item", "Needs Producer Review", "Reason"],
                [
                    (
                        p.get("paneId", ""),
                        p.get("tabId") or "—",
                        p.get("paneTitle", ""),
                        p.get("itemId") or "—",
                        str(_needs_review(p)),
                        p.get("reasonCode", ""),
                    )
                    for p in idle
                ],
            )
        )
    else:
        lines.append("_None._")
    lines.append("")
    lines.append("## Active")
    lines.append("")
    if active:
        lines.append(
            _md_table(
                ["Pane", "Tab", "Title", "Work Item", "Needs Producer Review", "Reason"],
                [
                    (
                        p.get("paneId", ""),
                        p.get("tabId") or "—",
                        p.get("paneTitle", ""),
                        p.get("itemId") or "—",
                        str(_needs_review(p)),
                        p.get("reasonCode", ""),
                    )
                    for p in active
                ],
            )
        )
    else:
        lines.append("_None._")
    lines.append("")
    return "\n".join(lines)


def render_log_tail(
    pane_title: str,
    needs_review: bool,
    lines: Sequence[str],
    tail: int = LOG_TAIL_LINES,
) -> str:
    """Render the last *tail* log lines under the required heading (AC4).

    Heading format: ``<pane title> Needs Review <true|false>``.
    """
    trimmed = list(lines)[-tail:]
    body = "\n".join(trimmed) if trimmed else "(no log output)"
    review_flag = "True" if needs_review else "False"
    return f"### {pane_title} Needs Review {review_flag}\n\n```\n{body}\n```"


# ---------------------------------------------------------------------------
# AC5 — recommendation rules (never-close guards apply universally)
# ---------------------------------------------------------------------------

def recommend_to_close(
    panes: Sequence[Mapping[str, Any]],
    invoking_pane_id: str | None,
) -> list[Mapping[str, Any]]:
    """Return idle panes eligible for the "Recommended to close" table.

    Exclusions (never-close guards, universal — manual + automatic reaper):
      - the invoking pane (by id, and defensively by classifier flag)
      - panes whose work item has ``needsProducerReview=true``
      - panes the classifier did not flag ``close``
    """
    recommendations: list[Mapping[str, Any]] = []
    for pane in panes:
        if not pane.get("close"):
            continue
        if _is_invoking(pane, invoking_pane_id):
            continue
        if _needs_review(pane):
            continue
        recommendations.append(pane)
    return recommendations


# ---------------------------------------------------------------------------
# AC6 — approval parsing (no approval → close nothing)
# ---------------------------------------------------------------------------

def select_approval(
    response: str,
    recommended_pane_ids: Sequence[str],
) -> list[str]:
    """Parse the producer's approval response (AC6).

    Returns the list of pane ids to close:
      - ``yes`` / ``y``              → all recommended panes
      - ``select 1,3`` / ``1 3``     → the indexed recommended panes (1-based)
      - anything else (incl. ``no``) → ``[]`` (closes nothing on ambiguity)
    """
    text = (response or "").strip().lower()
    if not text:
        return []
    if text in ("yes", "y"):
        return list(recommended_pane_ids)
    if text in ("no", "n"):
        return []
    if text.startswith("select"):
        text = text[len("select"):].strip()
    tokens = [t for t in text.replace(",", " ").split() if t]
    selected: list[str] = []
    for token in tokens:
        if not token.isdigit():
            return []  # ambiguous input closes nothing
        index = int(token)
        if 1 <= index <= len(recommended_pane_ids):
            selected.append(recommended_pane_ids[index - 1])
    return selected


# ---------------------------------------------------------------------------
# AC7 — re-verify before close
# ---------------------------------------------------------------------------

def close_selected_panes(
    approved_pane_ids: Sequence[str],
    current_panes: Sequence[Mapping[str, Any]],
    close_fn: Callable[[str], bool],
    list_panes_fn: Callable[[], Any],
    invoking_pane_id: str | None = None,
) -> dict[str, list[Any]]:
    """Close approved panes after re-verifying each is still idle (AC7).

    Immediately before closing, the pane list is re-read via *list_panes_fn*
    (which must return a bridge document or a pane list). Any approved pane
    that is no longer idle — or that has become the invoking pane — is skipped
    with a reason. The invoking pane is never closed.

    Returns ``{"closed": [...], "skipped": [{"paneId", "reason"}], ...}``.
    """
    approved = list(approved_pane_ids)
    if not approved:
        return {"closed": [], "skipped": [], "failed": []}

    fresh = list_panes_fn()
    if isinstance(fresh, dict) and isinstance(fresh.get("panes"), list):
        fresh_panes = [p for p in fresh["panes"] if isinstance(p, dict)]
    else:
        fresh_panes = [p for p in (fresh or []) if isinstance(p, dict)]
    by_id = {p.get("paneId"): p for p in fresh_panes}

    closed: list[str] = []
    skipped: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []

    for pane_id in approved:
        if invoking_pane_id and pane_id == invoking_pane_id:
            skipped.append({"paneId": pane_id, "reason": "invoking pane"})
            continue
        current = by_id.get(pane_id)
        if current is None:
            skipped.append({"paneId": pane_id, "reason": "pane no longer exists"})
            continue
        if not current.get("close"):
            skipped.append(
                {
                    "paneId": pane_id,
                    "reason": f"no longer idle ({current.get('reasonCode', 'unknown')})",
                }
            )
            continue
        if _needs_review(current):
            skipped.append({"paneId": pane_id, "reason": "needs producer review"})
            continue
        try:
            ok = close_fn(pane_id)
        except Exception as exc:  # noqa: BLE001 - recorded, not fatal
            failed.append({"paneId": pane_id, "reason": str(exc)})
            continue
        if ok:
            closed.append(pane_id)
        else:
            failed.append({"paneId": pane_id, "reason": "close returned false"})

    return {"closed": closed, "skipped": skipped, "failed": failed}


def render_ledger(result: Mapping[str, Sequence[Any]]) -> str:
    """Render the closure ledger as markdown (AC7)."""
    lines = ["## Closed", ""]
    for pane_id in result.get("closed", []):
        lines.append(f"- {pane_id} — closed")
    for entry in result.get("skipped", []):
        lines.append(f"- {entry.get('paneId')} — skipped: {entry.get('reason')}")
    for entry in result.get("failed", []):
        lines.append(f"- {entry.get('paneId')} — failed: {entry.get('reason')}")
    if len(lines) == 2:
        lines.append("_Nothing closed._")
    return "\n".join(lines)


def shell_quote(argv: Sequence[str]) -> str:
    """Return a shell-safe rendering of *argv* (for error/audit messages)."""
    return " ".join(shlex.quote(a) for a in argv)
