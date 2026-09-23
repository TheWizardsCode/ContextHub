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
4. **20260923-add-audit-fingerprint** — Adds the nullable `fingerprint` column used by the content-fingerprint freshness gate (WL-0MUBVH5S0008NQ9K)

The legacy `20260315-add-audit` migration is now a no-op since the audit column is no longer needed.

> **Automatic repair (WL-0MUEBQLRD00288VV).** `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a database created before migration `20260923-add-audit-fingerprint` lacks the `fingerprint` column and `wl audit-set` would fail with `table audit_results has no column named fingerprint` — silently, for the `a-y`/`a-r` background shortcuts. The store now repairs this additively on open (idempotent `ALTER TABLE audit_results ADD COLUMN fingerprint TEXT`) and records the same `audit_fingerprint_added` sentinel the doctor migration uses, so no manual `wl doctor upgrade` is required. `wl doctor upgrade` remains the path for any other pending migrations.

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

## Auto-revert on "not ready to close" verdict

When an item in `in_review` (status `completed`) receives a **not-ready-to-close** verdict, it is automatically reverted to status `open` / stage `plan_complete` so it drops out of the ready-to-close queue (heartbeat/release tooling) and returns to the planning queue for further work. The item's priority is preserved.

Triggers (both produce the same behavior):

- `wl update <id> --audit-text "Ready to close: No\n..."`
- `wl audit-set <id> --ready-to-close no`
- REST API `PUT /items/:id` (or `/projects/:prefix/items/:id`) with an `audit` body field whose first line is `Ready to close: No`

The reversion fires **only** when all of these hold:

1. The audit verdict is exactly "Ready to close: No" (no other audit text triggers it).
2. The item's current state is exactly `completed` / `in_review` (a `done` item, an already-`open`/`in-progress` item, or any other state is left untouched).
3. The reversion was not already applied (it is idempotent — a second not-ready write on an already-open item is a no-op).

Reporting (mirrors the priority-downgrade cascade / `demotedParent` convention):

- **JSON output** of `wl update` / `wl audit-set` includes a `reverted` field: `{ item, from: { status, stage }, to: { status, stage } }`, e.g. `{ "from": { "status": "completed", "stage": "in_review" }, "to": { "status": "open", "stage": "plan_complete" } }`. When no reversion occurs the field is absent.
- **Human output** prints a summary line: `[WL-XXX reverted from completed/in_review to open/plan_complete]`.
- **REST API** `PUT` responses include the same `reverted` field when the update caused a reversion.

The reversion is **best-effort**: if the lifecycle write fails (e.g. database lock), the audit write still succeeds and a warning is surfaced — the command never crashes.

The REST API path applies the same reversion for consistency with the CLI (decision recorded in WL-0MT0T1EQJ009DHO8). The `audit` field in a `PUT` body is routed to the `audit_results` table (the sole source of truth); a not-ready verdict then triggers the same reversion as the CLI commands.

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

## Audit Freshness

`isAuditFresh(auditedAt, updatedAt, storedFingerprint, currentFingerprint)` in
`packages/shared/src/icons.ts` is the **single freshness definition** consumed by
the TUI icon path (`stageDisplayIcon`), the `in_review` ordering predicate
(`inReviewBucket` / `compareInReviewItems`), and the downtime dispatcher
(`classifyItemForDispatch` / `selectAuditCandidate`). It evaluates two gates:

1. **Content-fingerprint gate (primary, WL-0MUBVH5S0008NQ9K).** When both a
   stored fingerprint (persisted on the `audit_results` row) and a current
   fingerprint are supplied, the audit is fresh iff they are equal. This makes
   freshness content-based: a metadata-only write that moves `updatedAt` — a
   post-audit comment, a sync-merge re-timestamp, or a `sortIndex` re-sort —
   leaves a fingerprinted audit fresh. A change to the auditable content
   (description/ACs, Key Files, git HEAD sha, or working-tree state) changes the
   fingerprint and marks the audit stale. The fingerprint is the canonical
   algorithm from the audit skill (`HEAD sha + description hash + Key Files +
   working-tree state`).
2. **Time gate (legacy fallback).** When no stored fingerprint is present
   (legacy audits) or the caller cannot supply a current fingerprint (e.g. a TUI
   render), the original `auditedAt > updatedAt - 60s` floor applies unchanged.

Freshness is **atomic**: `saveAuditResult` — the path behind `wl audit-set`,
`wl update --audit-text`, and the audit runner's `persist_audit.py` (see
`packages/shared/src/persistent-store.ts`) — writes the `audit_results` row
(including the optional `fingerprint`) and sets `workitems.updatedAt = auditedAt`
in the same transaction, so `isAuditFresh` is true immediately after an audit
(WL-0MT8KTE3E001Q1D9 / WL-0MTHRW3770014H51).

Fingerprint sources: `wl audit-set --fingerprint <hex>`, or an
`Audit content fingerprint: <hex>` line embedded in `--summary`/`--raw-output`
(the audit skill's report format), or `wl update --audit-text` carrying the same
line. An explicit `--fingerprint`/`--audit-fingerprint` flag wins over an
embedded line.

Flag-only flips of `needsProducerReview` do not bump `updatedAt`
(WL-0MSN6ZCTN0027U2R); comments do bump `updatedAt`, but a fingerprinted audit
stays fresh on a content match and a fingerprint-less audit stays fresh within
the 60 s window.

## Canonical Source of Truth

The `audit_results` row is the **sole consumer** of the audit verdict. No flow parses audit-content comments: heartbeat, ship gate, TUI, and implement all read `auditResult`/`auditedAt` from the record. Audit verdicts duplicated into work-item comments are deprecated/legacy and must not be added by audit flows — they only harm freshness by bumping `updatedAt`.

## Operational Notes

- Config: `auditWriteEnabled` controls whether audit writes are allowed.
- Storage: audit data is stored in the `audit_results` table with foreign key constraints and CASCADE DELETE semantics.
- Migration: Use `wl doctor upgrade --confirm` to apply schema migrations on existing databases. Required columns such as `audit_results.fingerprint` are repaired automatically on open, so audit writes work even when doctor has not been run (WL-0MUEBQLRD00288VV).
- Tests: Unit and integration tests cover valid first-line parsing, invalid first-line errors, redaction, whitespace handling, CRUD operations on the `audit_results` table, migration backfill, legacy column removal, and the atomic `updatedAt = auditedAt` freshness guarantee (`tests/database.test.ts` — audit-then-comment ordering and audit-text parity).

### Error Behavior

Both `wl audit-set` and `wl update --audit-text/--audit-file` now detect write failures (e.g., permissions issues, disk errors, database corruption) and return an error rather than silently succeeding:

- In **JSON mode** (`--json`): outputs `{ "success": false, "error": "<message>" }` with a non-zero exit code.
- In **human mode**: prints an error message to stderr and exits with code 1.

Previously, these commands always returned `success: true` regardless of whether the data was actually persisted.