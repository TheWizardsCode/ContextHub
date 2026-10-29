# Canonical audit content fingerprint (schema 2)

Work items: `WL-0MUN7QWFP0010EQC` (original TS port), `SA-0MVIDI8E00063OOP`
(schema 2 in the audit skill), `WL-0MVK5SWZE00254Y7` (this repository's
alignment).

## Why it exists

A stored audit (`audit_results.fingerprint`) is compared with the work item's
*current* content by the single freshness predicate
`isAuditFresh(auditedAt, updatedAt, storedFingerprint, currentFingerprint)` in
`packages/shared/src/icons.ts` — consumed by the TUI icon path, the `in_review`
ordering tier and the downtime dispatcher (see `docs/AUDIT_STATUS.md`).

`wl list --json` and `wl worklist --json` emit `currentFingerprint` so those
consumers can take the **primary content gate** instead of the 60 s time gate.
The digest must be byte-for-byte identical to the value the audit skill stores,
otherwise every audit looks stale.

## The contract (schema 2)

```text
sha256( json.dumps({
  "schema":           2,
  "title_hash":       sha256(title),
  "description_hash": sha256(description),
}, sort_keys=True) )
```

- **Item data only.** The description carries the acceptance criteria and the
  Key Files section, so both are covered by `description_hash`.
- **No git state, no comments, no lifecycle fields.** The computation performs
  zero git invocations: unrelated commits, touched-file edits, a dirty working
  tree, comments, assignee changes and stage transitions never invalidate an
  audit. Only the item's own `title`/`description` do.
- **Deterministic for garbage.** Missing/non-string values are coerced exactly
  as the Python side does (`None` → empty string, others → canonical JSON), so
  both implementations still agree.
- **Serialisation.** Python `json.dumps(..., sort_keys=True)` form: recursively
  sorted keys, `", "` / `": "` separators, `ensure_ascii` escaping, hashed as
  UTF-8. `src/audit-fingerprint.ts` implements this in `canonicalJson`.

Implementation: `computeContentFingerprint({ title, description })` in
`src/audit-fingerprint.ts`. It takes no git runner and is I/O-free, so a
`wl list` / `wl worklist` read computes it for every item cheaply — relevant on
large worklogs (`WL-0MVJC1EQX001QR9W`), where the previous git-based scheme
spawned `git` per touched path.

Python counterpart: `audit_runner._compute_content_fingerprint` with
`_AUDIT_CONTENT_FINGERPRINT_SCHEMA = 2` (SorraAgents `skill/audit`).

## Parity check and host tooling skew

`tests/unit/audit-fingerprint-parity.test.ts` computes the digest both ways for
the same work item and asserts equality. The installed audit skill is a symlink
into the agent framework (`scripts/install_pi.sh` → `~/.pi/agent/skills/audit`,
typically `~/projects/SorraAgents/skill/audit`), so its contract can move ahead
of (or behind) this repository between installs.

The test therefore probes the **installed** helper's contract
(`inspect.signature` + `_AUDIT_CONTENT_FINGERPRINT_SCHEMA`) through the shared
probe in `src/audit-fingerprint-installed.ts`:

| Installed helper | Result |
|---|---|
| schema 2, accepts `work_item=` | digests compared; a mismatch **fails** |
| schema ≠ 2 (ahead **or** behind) | **fail** with an actionable message naming the installed path, its schema, the expected schema and the remediation |
| schema undeclared (`_AUDIT_CONTENT_FINGERPRINT_SCHEMA` lookup returned nothing, i.e. a pre-v2 install) | **fail** — an undeclared schema cannot be proven compatible (fail-safe) |
| cannot accept `work_item=` | **fail** naming the installed signature |
| skill or `python3` missing (or the helper is unimportable) | **skip** naming what is missing |

The fail-on-skew policy is enforced by a **live-host gate** in the same file
(`liveHostSkewFailure`): when the probe returns `fail` the suite goes **red on
the machine running it**, quoting the probe's actionable message. A skew is
therefore never silent — probing the install and then quietly skipping the
digest comparison is exactly how a schema-1 host shipped a false-stale audit
badge (`LP-0MVKSXR4P001V0CM`). `skip` stays green so CI images without the
agent framework are unaffected.

Fail-on-skew is the contract: any schema skew **fails** the parity test loudly,
with the installed and expected schema plus the remediation, and never
masquerades as a code regression. `wl doctor` reports the same skew as the
warning-level `audit-fingerprint.schema-skew` check, built on the same probe, so
operators who never run the suite still see it. Only genuine environment
unavailability (no scripts directory, no `python3`, or an unimportable helper)
is not a failure, keeping CI images without the agent framework green.

Remediation on a skewed host:

```sh
# Re-install the agent framework skills from the canonical source
cd ~/projects/SorraAgents && git pull
scripts/install_pi.sh          # from this repo, or the framework's installer
# ...or point the test and wl doctor at a schema-2 install:
AUDIT_SKILL_SCRIPTS=/path/to/skill/audit/scripts npm --silent test -- tests/unit/audit-fingerprint-parity.test.ts
```

A host whose installed skill is **ahead** of this repository (e.g. schema 3)
fails by design: the message names both schemas, and the remedy is to port this
repository forward to that schema (bump `AUDIT_CONTENT_FINGERPRINT_SCHEMA` and
`computeContentFingerprint`, and update the parity fixtures) — not to suppress
the test.

To re-run just the parity check and the fingerprint unit tests:

```sh
npm --silent test -- tests/unit/audit-fingerprint.test.ts tests/unit/audit-fingerprint-parity.test.ts
```

## Migration note

Changing the schema invalidates previously stored fingerprints exactly once:
legacy audits fall back to the 60 s time gate until they are re-audited (or
favourably re-instated by `assessAuditInvalidate`), and the next audit stores a
schema-2 digest. No data migration is required.

## Retained utilities

`resolveTouchedFiles`, `computePathFingerprints`, `extractKeyFiles`,
`normaliseRepoPath`, `parsePorcelainPath` and `createGitRunner` remain exported
from `src/audit-fingerprint.ts` with their own unit tests, but they are **no
longer part of the fingerprint**. They have no production callers since schema
2; removing them is tracked separately so this contract change stays surgical.
