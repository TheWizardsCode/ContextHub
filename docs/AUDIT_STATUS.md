# Audit Status: Readiness Semantics

This document explains how Worklog derives and surfaces a conservative "readiness" status for structured audit metadata stored on work items.

Goals
- Provide a deterministic, conservative readiness summary for free-form audit text.
- Avoid rejecting writes when an operator claims completion but the work item lacks explicit acceptance criteria.
- Make audit status visible in human outputs (concise/normal/full) and surface a subtle, non-blocking warning when verification is not possible.

How status is derived
- Only the first non-empty line of the audit text is inspected.
- Deterministic token maps (case-insensitive) are used to map that line to one of:
  - `Complete` — tokens: `ready to close`, `ready`, `complete`, `closed`, `done`
  - `Partial` — tokens: `partial`, `incomplete`, `needs work`, `some work`
  - `Not Started` — tokens: `not started`, `todo`, `open`
  - `Missing Criteria` — default when none of the tokens match or the input is empty.

Conservative acceptance-check
- When an audit claims `Complete`, Worklog will conservatively mark it as `Missing Criteria` if the associated work item does not contain explicit acceptance or success criteria.
- The presence of acceptance criteria is signalled via the `hasAcceptanceCriteria` flag passed to the audit builder. The CLI and API set this flag as follows:
  - CLI create: derived from the create description.
  - CLI update: derived from the update description if provided; otherwise derived from the stored item's description.
  - API create: derived from the request body description.
  - API update: derived from the request body description if present; otherwise the API fetches the stored item to determine whether acceptance criteria exist before building the audit entry.

Redaction
- Email-like strings are redacted deterministically before being persisted: local part becomes first-character + `***` and the domain is kept (e.g. `alice@example.com` -> `a***@example.com`).

Human outputs
- The audit status is included in concise/normal outputs as an inline suffix: `Audit: <excerpt> (<status>)`.
- In `full` output the audit block includes `Readiness: <status>` followed by the full redacted text and author/time.
- When the status is `Missing Criteria`, a non-blocking warning line is shown in human output to make operators aware without rejecting the write.

Why conservative?
- The system avoids making unverifiable assertions. Acceptance criteria may live outside the system or be phrased inconsistently; the conservative policy prevents falsely recording `Complete` without corroborating acceptance criteria.

Operational notes
- Config: `auditWriteEnabled` controls whether audit writes are allowed.
- Stored format: audit objects are stored as JSON in the existing `audit` TEXT column and include `time`, `author`, `text`, and `status`.
- Tests: Unit tests cover parseReadinessLine behavior and integration tests cover create / update roundtrips and human output formatting.

If you'd like, I can add a short note to CLI help text (`create --help` / `update --help`) to explain this behavior.
