# Cross-repo restore — producer-review flag in the ship gate & audit runner

> Work item: WL-0MVAPF1QM005FYM1 (child of epic WL-0MVAMS4RO000H3B0).
> Repo boundary: the ship gate and audit runner live in the **SorraAgents**
> skill tree; the restore was delivered as SorraAgents work items (not edited
> from ContextHub).

## Why

The `needsProducerReview` flag was removed (WL-0MV85WFYU0071YQ9 /
WL-0MV85WGIT004PHRC) and its two roles — the audit verdict's producer signal
and the ship release gate — were re-homed onto an assignee sentinel
(`assignee === 'Map'`). That removal was a wrongful deletion
(RCA WL-0MVAOYBZM0065AEN). ContextHub restored the flag (F2/F3/F4/F5); the
SorraAgents side is restored here.

## Delivered

| SA item | Scope | Commit |
|---|---|---|
| SA-0MVB1QFXI004T4G5 | Audit runner: `'yes'` verdict sets `--needs-producer-review yes` (top-level items); merge-gate blocker flags it; the audit claim is always cleared with `--assignee ""` (status-neutral CAS kept; `_PRODUCER_HOLD_ASSIGNEE` removed). | `4fd33cb4` |
| SA-0MVB1Q6DR007I49R | Ship gate: `check-final-validation.js`, `check-audit-gate.js`, `run-release.js` block release on `needsProducerReview === true` again; the producer-hold assignee sentinel is removed. | `05ec727b` |

Both SA items are `completed`/`in_review`; SA full suite green
(audit-runner tests 213 + 49, ship-gate tests 200).

## Kept (Q2=C — not reverted)

- `wl update --if-assignee` atomic CAS and the **status-neutral audit-tier
  claim** (WL-0MV85WBDB003J35W / WL-0MV85WCJJ0087VMP) — the
  WL-0MV7W77AY005MGBL fix is preserved. `isAssigneeHeld` (any non-empty
  assignee is a scheduling hold) remains.
- The audit runner's legacy-hybrid recovery (`in-progress`/`in_review` →
  `completed`/`in_review`) is preserved.

## Retired

- The producer-hold assignee sentinel (`PRODUCER_HOLD_ASSIGNEE` /
  `isProducerHold` / `markProducerHoldWorkItem` / `producer-hold.ts`): no
  producer-review semantics remain on the assignee. The producer-review signal
  is the flag again, toggled by `wl reviewed <id>`.

## Verification

- ContextHub: `wl reviewed`, `--needs-producer-review` on create/update and the
  list/search/next filters, the ❌/✅ selection-list icon, and 6-bucket
  review-queue grouping are restored (F2–F5).
- SorraAgents: flag-based ship gate + audit-runner verdict marking restored and
  tested.
- End-to-end: a top-level `'Ready to close: Yes'` audit sets
  `needsProducerReview=true`; `check-final-validation.js` blocks release until
  the producer clears it (`wl reviewed <id> false`) — the pre-removal release
  guarantee.

## Related

- ContextHub WL-0MVAMS4RO000H3B0 (epic), WL-0MVAPF1QM005FYM1 (this item)
- SA-0MVB1QFXI004T4G5, SA-0MVB1Q6DR007I49R (delivery)
- Reversed: SA-0MV9DUE6F006SK1H (ship-gate re-homing), SA-0MV98PAT7005VXXS
  (audit-runner producer marking; assignee-clear retained)
