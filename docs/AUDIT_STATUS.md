# Audit Status: Readiness Semantics

This document explains how Worklog derives and surfaces a conservative "readiness" status for structured audit metadata stored on work items.

## Overview

Worklog stores audit results in a dedicated `audit_results` table, separate from the `workitems` table. Each work item has at most one audit result (latest-only storage). The audit result captures:

- **work_item_id** — Foreign key to the work item
- **ready_to_close** — Boolean (stored as INTEGER): `1` = Complete, `0` = Partial
- **audited_at** — ISO 8601 timestamp of when the audit was performed
- **summary** — Human-readable summary text (the full audit text)
- **raw_output** — Optional machine-readable output (null if not provided)
- **author** — Who performed the audit

## Migration

The `audit_results` table was introduced in schema version 8. A migration backfills data from the legacy `workitems.audit` JSON column and then drops that column. The migration is:

1. **20260604-add-audit-results** — Creates the `audit_results` table
2. **20260604-backfill-audit-results** — Reads `workitems.audit` JSON and inserts rows into `audit_results`
3. **20260604-drop-audit-column** — Drops the `audit` column from `workitems`

The legacy `20260315-add-audit` migration is now a no-op since the audit column is no longer needed.

## CLI Commands

### Setting audit results

```bash
# Set audit via --audit-text (existing interface, now writes to audit_results)
wl update SA-123 --audit-text "Ready to close: Yes
All acceptance criteria verified."

# Set audit via the new dedicated command
wl audit-set SA-123 --ready-to-close --summary "All acceptance criteria verified." --author agent

# Mark an audit as approved by manual review
wl audit-set SA-123 --ready-to-close yes --summary "Manual review approved." --author "reviewer-name"

# Mark an audit as not yet ready (e.g., after a failed review)
wl audit-set SA-123 --ready-to-close no --summary "Manual review failed: criteria X not met."
```

> **Note:** `--ready-to-close` accepts both a bare flag (`--ready-to-close`) which defaults to `yes`,
> and an explicit value (`--ready-to-close yes` or `--ready-to-close no`).

### Viewing audit results

```bash
# View audit for a work item (JSON output)
wl audit-show SA-123 --json

# Audit result is also included in wl show --json as workItem.auditResult
wl show SA-123 --json
```

## Status Derivation

- Only the first non-empty line of the audit text is inspected.
- The trimmed line must exactly match one of:
  - `Ready to close: Yes` → `Complete` (ready_to_close = 1)
  - `Ready to close: No` → `Partial` (ready_to_close = 0)
- Any other first line is invalid for CLI `--audit-text` writes and is rejected with:
  - `error: audit-invalid-first-line`
  - a `message` containing the found trimmed first line and indicators for BOM/non-printable/gutter characters.

## Valid Examples

```text
Ready to close: Yes

## Summary
All acceptance criteria verified.
```

```text
  Ready to close: No

## Summary
Two checks still failing.
```

## Invalid Examples

```text
Ready to close
```

```text
Looks good to me
```

```text
┃ Ready to close: No
```

## Redaction

- Email-like strings are redacted deterministically before being persisted: local part becomes first-character + `***` and the domain is kept (e.g. `alice@example.com` → `a***@example.com`).

## JSON Output Format

When using `wl show <id> --json`, the audit data is included in two formats:

### `workItem.audit` (backwards-compatible format)

```json
{
  "text": "Ready to close: Yes\nAll acceptance criteria verified.",
  "author": "agent-name",
  "time": "2026-06-07T12:30:00.000Z",
  "status": "Complete"
}
```

Fields:
- **text** — The full audit text with email addresses redacted
- **author** — Who performed the audit
- **time** — ISO 8601 timestamp of when the audit was performed
- **status** — Derived from the first line: `Complete` or `Partial`

### `workItem.auditResult` (normalized format)

```json
{
  "readyToClose": true,
  "summary": "Ready to close: Yes\nAll acceptance criteria verified.",
  "auditedAt": "2026-06-07T12:30:00.000Z",
  "author": "agent-name"
}
```

Fields:
- **readyToClose** — Boolean: `true` if ready to close, `false` otherwise
- **summary** — The full audit text
- **auditedAt** — ISO 8601 timestamp
- **author** — Who performed the audit

## Why Strict First-Line Matching?

- It provides deterministic behavior and clear operator expectations.
- It avoids accidental status inference from arbitrary prose.
- It makes validation errors precise and actionable.

## Operational Notes

- Config: `auditWriteEnabled` controls whether audit writes are allowed.
- Storage: audit data is stored in the `audit_results` table with foreign key constraints and CASCADE DELETE semantics.
- Migration: Use `wl doctor upgrade --confirm` to apply schema migrations on existing databases.
- Tests: Unit and integration tests cover valid first-line parsing, invalid first-line errors, redaction, whitespace handling, CRUD operations on the `audit_results` table, migration backfill, and legacy column removal.

### Error Behavior

Both `wl audit-set` and `wl update --audit-text/--audit-file` now detect write failures (e.g., permissions issues, disk errors, database corruption) and return an error rather than silently succeeding:

- In **JSON mode** (`--json`): outputs `{ "success": false, "error": "<message>" }` with a non-zero exit code.
- In **human mode**: prints an error message to stderr and exits with code 1.

Previously, these commands always returned `success: true` regardless of whether the data was actually persisted.