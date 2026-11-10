# Release window vs. the host dispatch budget — evaluation

**Work item:** WL-0MW7YIBG70021YI3 · **Date:** 2026-11-10 · **Scope:** analysis only

## Recommendation (summary)

**A dedicated "release budget" slot is not recommended.** The host dispatch
budget ledger counts **dispatched agent panes**; the release process runs
**subprocesses** (`audit_runner.py`, `run_tests.py`, `git`/`gh`) that are not
panes and therefore cannot be meaningfully reserved or released by an
`itemId`-keyed ledger entry. A release reservation would be a *declaration* of
resource use, not a measurement of it — it would reduce the concurrency other
work is allowed without bounding the resource consumption the operator is
actually worried about.

The Code Freeze mechanism is **sufficient for the window it owns**: while a
release runs, no *new* implement or audit dispatch starts for that project, and
in-progress work is allowed to continue. Two residual gaps remain and are
recorded below rather than papered over:

1. **Scope mismatch** — the freeze is **per worklog root**; the budget ledger is
   **machine-scoped**. A release in one project does not stop another project on
   the same host from dispatching implement/audit work. Follow-up:
   **WL-0MWAM5N75004ROSW** (host-wide release barrier).
2. **Subprocess accounting** — the release's own subprocess resource use is
   invisible to the ledger. This is *accepted*, because the release bounds it
   itself (serial audit remediation + wall-clock/item budgets) and the host-CPU
   dispatch gate refuses new heavy dispatch machine-wide at/above its threshold.

## 1. The Code Freeze mechanism and the dispatch budget

### Marker contract

The freeze state lives in `.worklog/code-freeze.json` (per project root);

```json
{ "active": true, "reason": "ship release in progress",
  "startedAt": "<ISO>", "pid": 12345 }
```

`packages/herdr/src/code-freeze.ts` exposes a tri-state read
(`readCodeFreezeStatus`): `frozen`, `not-frozen`, `ambiguous`. The dispatcher
treats a marker it cannot trust (unreadable, corrupt JSON, wrong shape) as
**frozen** — fail-closed, so a broken marker can never silently admit
implementation work mid-release. Fail-*open* is used only for worklist browsing
and shortcut blocking, where a broken marker must never lock the operator out.

### Where the freeze sits in the filter chain

The dispatcher's sequential filter chain is:

```
scheduled-prompt → code-freeze → producer-review gate → dispatched-marker
→ free-slot minimums → host-wide dispatch budget → freshness/recency
→ CAS claim → spawn
```

The **code-freeze gate is evaluated before budget admission**. When frozen, the
dispatcher does not even reach `admitHostDispatch` for the skipped tiers — no
reservation is taken, so the skipped tiers consume **no** budget slot.

### Tier behaviour while frozen (`downtime-worker.dispatch.ts`)

`frozen = freezeStatus === 'frozen' || freezeStatus === 'ambiguous'`.

| Tier | While frozen | Notes |
|---|---|---|
| **audit** (non-critical) | **skipped** | Gate wraps the whole audit-tier block (`if (!frozen && !cpuSaturated)`) |
| **non-critical implement** | **skipped** | Gate wraps the non-critical implement block |
| **critical implement** (`plan_complete`) | **skipped** | Split-by-skill: no new code lands mid-release |
| **critical prep** (`idea` / `intake_complete`) | **still dispatches** | Low-risk prep, same as non-critical plan/intake |
| **non-critical plan** (`intake_complete`) | **still dispatches** | Prep is low-risk |
| **non-critical intake** (`idea`) | **still dispatches** | Prep is low-risk |
| scheduled prompts | **skipped** | `if (!frozen && panesEligible)` |
| review-queue gate read | **skipped** | Read is skipped while frozen |
| stalled-pane resume | **suppressed** | `resumeStalledWorkIfAble(... frozen ...)` |
| **in-progress panes** | **continue** | The freeze gates *new* dispatch only; nothing interrupts a running pane |

So the evaluation brief's assumption holds: **the code-freeze gate prevents all
new implement and audit dispatches** (critical and non-critical alike) while a
release runs, and the constraint that in-progress items must be allowed to
continue is satisfied by construction — the markers are admission gates, not
termination signals.

A freeze skip with an empty plan/intake backlog is reported as
`code-freeze` (**never** `no-candidate`), so the no-candidate cooldown does not
arm and implement/audit dispatch resumes on the first tick after the freeze
lifts.

The worklist enforces the same freeze client-side: implement shortcuts are
marked `code_freeze: "block"` and the list renders a prominent
`⛔ CODE FREEZE` banner, so a human cannot hand-fire `/skill:implement` for the
frozen project either.

### Freeze is per root; the ledger is host-wide

The coordination leader re-reads `readCodeFreezeStatus(root)` for **each
registered root**, so a root's own freeze cannot be bypassed — and, crucially,
a frozen root does **not** block a sibling root's dispatch. The freeze marker is
project-scoped; `budget.json`/`dispatch-budget.json` in
`~/.herdr/downtime` are machine-scoped. **This is the real scope gap** (see
§3 and the follow-up item).

## 2. The release process's subprocess calls

The release orchestration is `~/.pi/agent/skills/ship/scripts/run-release.js`
(and `release/merge-dev-to-main.sh`). It is not a dispatcher tier at all:
`budgetKindForAgentCommand` recognises only `/skill:implement*` and
`/skill:audit*`, so `/skill:ship` is **outside the budget** even when
hand-fired from the worklist. The release's subprocess calls:

| Call | Where | Budget-gated? | Bound |
|---|---|---|---|
| `audit_runner.py issue <id>` (in-gate audit remediation) | `audit-remediation.js` ← `checkAuditReadyToClose`, `checkFinalValidation` | **No** | **Serial** (parallel spawns were removed — SA-0MUIUMO7T00639FL); per-item `SHIP_AUDIT_REMEDIATION_TIMEOUT_MS`; total `SHIP_AUDIT_REMEDIATION_BUDGET_MS` wall clock + `SHIP_AUDIT_REMEDIATION_MAX_ITEMS` |
| `audit_runner.py batch` (offline refresh hint / pre-flight `--refresh-audits`) | `audit-remediation.js`, `refresh-audits.js` | **No** | Batch-drain wall-clock budget; runs before the freeze marker on the pre-flight path |
| `run_tests.py --scope full` (the dev-push / release test gate) | `release/merge-dev-to-main.sh` | **No** | One full-suite run through the test skill's runner |
| `git merge` / `git push` / `git tag` / `gh pr create` / `gh pr merge` / `wait_for_pr_checks.py` | `release/merge-dev-to-main.sh`, `run-release.js` | **No** | PR-check poller has its own timeout |
| `wl` queries (gates, close, cleanup) | `run-release.js` steps | **No** | per-command |

**Confirmation.** Neither `audit_runner.py` nor `run_tests.py` contains any
reference to the host budget ledger or `admitHostDispatch`; the only "budget"
identifiers in `audit_runner.py` are wall-clock/call timeouts. The `git`/`gh`
operations are shell/spawn calls in the merge script. **None of the release's
subprocesses pass through the dispatcher's budget admission gate**, and none is
recorded in `dispatch-budget.json`. The release process therefore **bypasses
the dispatch budget entirely** — it neither consumes nor is limited by
`maxImplement`/`maxAudit`.

## 3. Assessment: would a "release budget" slot add value?

A release slot would consume both an implement and an audit slot for the
duration of the release. Weighing that against the code-freeze mechanism:

**What the code-freeze already achieves**

- No *new* implement/audit dispatch for the releasing project, from the
  dispatcher or from the worklist shortcuts.
- In-progress panes continue (explicitly required).
- No budget slot is reserved by skipped tiers.
- Fail-closed on an ambiguous marker.
- Automatic clearance on every release exit path, so no stale hold.

**Why a ledger reservation does not add a real safeguard**

- **It measures the wrong thing.** The ledger's unit is a *dispatched pane*
  keyed by work-item id, released on pane close. Release subprocesses have no
  work-item key, may be several processes (serial audits, one test run, git/gh),
  and outlive individual items. A single "release" entry would be a
  declaration, not an observation: it cannot bound the release's CPU/memory
  use, which is the operator's stated worry.
- **It would be a blunt host-wide throttle.** Reserving one implement + one
  audit slot machine-wide reduces *other* roots' capacity, even though the
  release might never use that much — the reverse of a measurement.
- **The heavy part is already bounded.** Audit remediation is serial with a
  wall-clock and item cap; the test gate is a single run; PR checks are polled
  with a timeout. The host-CPU dispatch gate already refuses *new* heavy
  dispatch machine-wide at/above its threshold, covering concurrent machine
  pressure regardless of cause.
- **It duplicates the freeze's job.** For the releasing project the freeze is
  strictly stronger (no dispatch at all, rather than a capped slot), so a slot
  would only matter for *other* projects — and that is a scope problem, not a
  budget problem.

**Is it a natural extension of WL-0MW50EHZ6007QBPB?** No. That item generalises
the budget from two hard-coded **dispatch kinds** (`implement`, `audit`) to any
kind (`plan`, `intake`, `risk-effort`), where a kind is still a *dispatched
agent pane*. A release is not a dispatch kind: its work is subprocesses, not
panes. Making "release" a budget kind would stretch `HostBudgetKind` beyond its
meaning and require a reservation with no liveness evidence (no pane id, no
work-item key) — exactly the unresolvable states the ledger's liveness table
exists to make explicit. A **machine-scoped release barrier** (a separate
marker honoured by the dispatcher for implement/audit on every root) is the
natural reuse of the machine-coordination infrastructure, and is captured as
WL-0MWAM5N75004ROSW rather than folded into the generalisation item.

## 4. Residual gaps (documented, not hidden)

| Gap | Severity | Why it is acceptable now | Follow-up |
|---|---|---|---|
| Freeze is per root; budget is host-wide — another project can dispatch implement/audit during a release | Medium | Per-root correctness was the original design; most operators run one active project per host | **WL-0MWAM5N75004ROSW** |
| Release subprocess resource use is invisible to the dispatch ledger | Low | Bounded by serial audit remediation + `SHIP_AUDIT_REMEDIATION_*` budgets + single test-gate run; the host-CPU gate refuses new heavy dispatch machine-wide at saturation | None — accepted; documented here |
| A release started around an already-running in-progress implement pane on the same project | Low | The freeze deliberately lets in-progress work finish; the Ship It guard already blocks confirmation when live panes work on this project's items, and `/skill:ship` runs the audit/critical/unmerged-branch gates before merging | None — behaviour is intentional |

## 5. Follow-up work

- **WL-0MWAM5N75004ROSW** — *Host-wide release barrier: pause new
  implement/audit dispatch on every root while a release runs.* Introduces a
  machine-scoped release marker (alongside the budget ledger) that the
  dispatcher honours for implement/audit on **every** root, leaving
  in-progress panes and plan/intake prep untouched. This closes gap 1 without a
  budget slot.
- **WL-0MW50EHZ6007QBPB** — *Generalise host dispatch budget to any work item
  type* — related but orthogonal (see §3); no scope change recommended.

No other implementation work is implied by this evaluation.

## References

- `packages/herdr/src/code-freeze.ts` — marker detection, tri-state read,
  writer/clearer.
- `packages/herdr/src/downtime-worker.dispatch.ts` — code-freeze gate and tier
  behaviour (`frozen = freezeStatus === 'frozen' || freezeStatus === 'ambiguous'`).
- `packages/herdr/src/host-dispatch-budget.ts` — ledger, liveness table,
  configuration.
- `packages/herdr/src/host-dispatch-budget.admission.ts` — the single admission
  read (`admitHostDispatch`, `readAuditBudgetState`).
- `packages/herdr/src/host-dispatch-budget.interactive.ts` —
  `budgetKindForAgentCommand` (implement/audit only; `/skill:ship` outside the
  budget).
- `~/.pi/agent/skills/ship/scripts/run-release.js` — release orchestration,
  freeze write/clear, gate steps.
- `~/.pi/agent/skills/ship/scripts/audit-remediation.js` — serial, bounded
  in-gate audit remediation.
- `~/.pi/agent/skills/ship/scripts/release/merge-dev-to-main.sh` — merge, test
  gate, `git`/`gh` operations.
- `~/.pi/agent/skills/audit/scripts/audit_runner.py` — audit subprocess
  execution (timeout "budgets" only; budget-agnostic).
- `~/.pi/agent/skills/test/scripts/run_tests.py` — test-runner subprocess
  (budget-agnostic).
- `docs/dev/downtime-dispatcher.md` — *Host-wide dispatch budget* and
  *Critical-first tier & freeze split-by-skill*.
