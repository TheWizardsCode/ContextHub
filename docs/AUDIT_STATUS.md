# Audit Status: Readiness Semantics

This document explains how Worklog derives and surfaces a conservative "readiness" status for structured audit metadata stored on work items.

Goals
- Provide a deterministic readiness summary based on an explicit first-line contract.
- Ensure valid audits are accepted when the first non-empty line is well-formed.
- Return actionable errors when the first-line contract is violated.

How status is derived
- Only the first non-empty line of the audit text is inspected.
- The trimmed line must exactly match one of:
  - `Ready to close: Yes` -> `Complete`
  - `Ready to close: No` -> `Partial`
- Any other first line is invalid for CLI `--audit-text` writes and is rejected with:
  - `error: audit-invalid-first-line`
  - a `message` containing the found trimmed first line and indicators for BOM/non-printable/gutter characters.

Valid examples

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

Invalid examples

```text
Ready to close
```

```text
Looks good to me
```

```text
┃ Ready to close: No
```

Redaction
- Email-like strings are redacted deterministically before being persisted: local part becomes first-character + `***` and the domain is kept (e.g. `alice@example.com` -> `a***@example.com`).

Human outputs
- The audit status is stored with the audit object and available in JSON output as `workItem.audit.status`.

Why strict first-line matching?
- It provides deterministic behavior and clear operator expectations.
- It avoids accidental status inference from arbitrary prose.
- It makes validation errors precise and actionable.

Operational notes
- Config: `auditWriteEnabled` controls whether audit writes are allowed.
- Stored format: audit objects are stored as JSON in the existing `audit` TEXT column and include `time`, `author`, `text`, and `status`.
- Tests: Unit and integration tests cover valid first-line parsing, invalid first-line errors, redaction, whitespace handling, and reported edge cases.

If you'd like, I can add a short note to CLI help text (`create --help` / `update --help`) to explain this behavior.
