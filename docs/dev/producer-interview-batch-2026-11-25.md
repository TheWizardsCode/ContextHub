# Producer interview batch — 2026-11-25T16:01:53.100Z

**Batch id:** `2026-11-25T16:01:53.100Z` · **Rows:** 17 · **Roots:** 4

**Per-root counts:** `/home/rgardler/projects/AI_Hell` 5 rows · `/home/rgardler/projects/ContextHub` 1 row · `/home/rgardler/projects/SorraAgents` 9 rows · `/home/rgardler/projects/tce-the-rising` 2 rows

## How to answer

Reply once, **per row number** (for example `1: clear it`, `2: keep waiting because …`).
A row you do not answer **stays flagged** and remains grouped `needs-producer-input`.
Answering a row **is the authorisation** for that row's flag clear — no answer, no clear.

Recommendations below are **advisory only** — answer however you prefer and your answer is what gets applied.

### `/home/rgardler/projects/AI_Hell` (5 rows)

#### Row 1 — AH-0MWEUSVJ1007EXJY

- **Root:** `/home/rgardler/projects/AI_Hell`
- **Title:** Post-MVP Hangar War: hull upgrade bays as a reward axis
- **Deciding evidence:** `comment:AH-C0MWGX0EL7000ZLLB`
- **Flag age:** 10d 18h

**Question**

> question: Intake stalled on three scope questions — the design of record names 'extra upgrade bays' as a hull reward axis but no definition of a bay exists in the repo (only the shipped six-slot power-up/weapon cap POWER_UP_SLOT_CAP=6 and the uncapped hangar loadout). Please answer Q1–Q3 (recommended options marked); intake resumes once answered.
>
> Q1 (what a bay grants in the run): (a) one extra shared run loadout slot — bay hull deploys with a raised equipment cap (6+N) for that deployment, parameterising the shared slot accounting (recommended; the only option with real in-run impact like extra hit points); (b) one extra starting-weapon slot in the hangar loadout selector (run still trims to the shared cap); (c) one extra hangar modifier slot; (d) other.
>
> Q2 (how far this item goes): (a) model + mechanics + one shipped catalogue bay hull (e.g. hull-4, grantable via resolveHexGrant) exercised by GymHangar, rotation-offer wiring as a follow-on (recommended); (b) also wire the bay hull as the second special reward in the shipped rotation now; (c) model + mechanics only, bay hull as test/fixture data only.
>
> Q3 (persistence): (a) bay count authored in the catalogue only (HullRunStats.upgradeBays), resolved count carried as launch data in the deployment payload (recommended; active hull id is already stored, no second source of truth); (b) also store an explicit bay field on the payload (HangarState/HangarWarPayload), field-presence migrated.

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 2 — AH-0MWLLPA1Q0006U2P

- **Root:** `/home/rgardler/projects/AI_Hell`
- **Title:** Implement route-through collection re-tune
- **Deciding evidence:** none (no surviving evidence)
- **Flag age:** unknown

**Question**

> does it still need producer attention?

**Recommended:** confirm whether it still needs producer attention — no deciding evidence survives, so only you can say whether the flag is still needed (advisory only)

#### Row 3 — AH-0MWW5BI5C006WOI3

- **Root:** `/home/rgardler/projects/AI_Hell`
- **Title:** Chrono Field nerfing
- **Deciding evidence:** `description:AH-0MWW5BI5C006WOI3:OPEN_QUESTION`
- **Flag age:** unknown

**Question**

> ### Open questions (routed to the producer)
>
> **Q1 — Field geometry and scale (what "limit the range" means).**
> Options:
> - **(a)** Ship-centred circle of a **fixed** radius of about **180 px** (≈19 %
>   of the 960 px playfield width, comfortably larger than the Force Field bubble's
>   36 px), identical at every Chrono level.
> - **(b)** Ship-centred circle whose radius **grows with the Chrono level** (new
>   `chronoRadius` axis on the existing curve, e.g. 150 px → 300 px), so upgrades
>   widen *and* deepen the field.
> - **(c)** A **stationary** zone anchored where the pickup was collected (or at
>   the screen centre), which the player must fly into.
>
> **Recommended\:** (a) — the smallest, most predictable change that satisfies
> "limit the range", keeps the level curve focused on strength/duration (so the
> existing upgrade path does not silently refund the nerf), and lands a fixed
> number the docs can state plainly. (b) is attractive if Chrono's late levels
> should *feel* like a bigger field; (c) changes the power-up's identity and makes
> its value depend on where the drop happened.
>
> **Q2 — Is the limited range visible to the player?**
> Options:
> - **(a)** Add a subtle ship-centred **active-field ring** at exactly the slowed
>   radius (same drawing seam the Force Field bubble / Thorn aura use), visible
>   only while the window is active.
> - **(b)** **No new VFX** — the HUD row and countdown stay the only readout; the
>   range is intentionally unmarked (smallest scope).
> - **(c)** A full-screen tint/desaturation plus the ring (heavier, affects
>   readability of bullets).
>
> **Recommended\:** (a) — an invisible boundary on a positional effect reads as a
> bug; the ring is a small, existing-pattern addition and makes the nerf legible.
> (b) is acceptable if VFX scope must stay at zero, in which case the docs record
> that the boundary is deliberately unmarked.
>
> **Q3 — Does the halving apply to every level, or only the level-0 baseline?**
> Options:
> - **(a)** **Halve the whole axis**: `chronoSlowFactor` base 0.5 → **0.25** and
>   cap 0.75 → **0.375** (bullets at 75 % → 62.5 % of normal speed at every
>   level).
> - **(b)** **Halve only level 0**: base 0.25 but keep the 0.75 cap, so level 0 is
>   nerfed while a fully upgraded field still slows bullets nearly to a stop.
>
> **Recommended\:** (a) — "50 % of its current reduction" reads as a property of
> the effect, and (b) would leave the late-game field as dominant as it is today,
> which is the behaviour the operator is complaining about.
>
> **Note:** if all three recommendations are accepted, implementation proceeds
> with no further producer input.

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 4 — AH-0MWW6PNA5008NC91

- **Root:** `/home/rgardler/projects/AI_Hell`
- **Title:** Feature: Auto-derive hangar catalogue weapon entries from weapons.csv
- **Deciding evidence:** none (no surviving evidence)
- **Flag age:** unknown

**Question**

> does it still need producer attention?

**Recommended:** confirm whether it still needs producer attention — no deciding evidence survives, so only you can say whether the flag is still needed (advisory only)

#### Row 5 — AH-0MWWARIW6003F7OV

- **Root:** `/home/rgardler/projects/AI_Hell`
- **Title:** Bug: Ring-2 modifier grants have no hangar catalogue entry
- **Deciding evidence:** none (no surviving evidence)
- **Flag age:** unknown

**Question**

> does it still need producer attention?

**Recommended:** confirm whether it still needs producer attention — no deciding evidence survives, so only you can say whether the flag is still needed (advisory only)

### `/home/rgardler/projects/ContextHub` (1 row)

#### Row 6 — WL-0MWAJ3RPX000HQIG

- **Root:** `/home/rgardler/projects/ContextHub`
- **Title:** Decide whether to remove the own-backlog fallback and its leadership step-down (superseded premise)
- **Deciding evidence:** `comment:WL-C0MWHP2X210072E21`
- **Flag age:** 10d 5h

**Question**

> **Producer review required** — this decision has architectural implications for the coordination protocol. Please confirm or reject option (c).

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

### `/home/rgardler/projects/SorraAgents` (9 rows)

#### Row 7 — SA-0MSN9UXKJ002JK42

- **Root:** `/home/rgardler/projects/SorraAgents`
- **Title:** Merge conflict: feature/wl-42-test-change
- **Deciding evidence:** `comment:SA-C0MWMTG2ZX001R5A9`
- **Flag age:** 6d 15h

**Question**

> **Questions for producer:**
> 1. Was `feature/wl-42-test-change` intentionally deleted, or should it be restored?
> 2. If the conflict was already resolved manually, can you confirm?
> 3. Should this work item be closed as obsolete, or is there another course of action?

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 8 — SA-0MU9VU8GB009P523

- **Root:** `/home/rgardler/projects/SorraAgents`
- **Title:** Run the 24h STE100 experiment: apply treatment, measure, report, revert
- **Deciding evidence:** `comment:SA-C0MUJNHTF4007Q22T`
- **Flag age:** 59d 5h

**Question**

> question: The 24h experiment needs a wall-clock window (T0 → T0+24h) and a guaranteed revert afterwards. A single agent session cannot span 24h, so implementation is gated here. Please choose how the window is supervised:
>
> (a) I apply the STE sentence to AGENTS_GLOBAL.md now, record T0 + commit hash, and rely on the herdr downtime worker to re-dispatch this item later. That requires a resumable design: read T0 from this item's comments; if now < T0+24h, stop and release; if now >= T0+24h, run the analysis, write docs/experiments/ste100-24h/report.md, revert, and finish. Confirm the worker will re-dispatch this item after a 24h window (and that needs-producer-review=false at that point).
> (b) Add a daily '/skill:implement SA-0MSMC8KRS00164VD' entry to .worklog/scheduled-prompts.json so a follow-up is guaranteed. Please confirm the consumer of that file is active.
> (c) You (the producer) manually trigger the follow-up at T0+24h.
> (d) Defer or cancel the experiment (e.g. if 24h of representative activity is unlikely).
>
> question: Is it acceptable to leave the global AGENTS_GLOBAL.md treatment active (it affects every project's sessions) until the follow-up runs? What is the maximum acceptable overrun beyond T0+24h before I must revert unconditionally?
>
> Context: the measurement tooling is complete and on dev (commit 9b5225ec) — skill/ste100-experiment/scripts/analyze_sessions.py + tests. Only the timed experiment itself (apply → wait 24h → measure → report → revert) is blocked.
>
> Note: this work item was 'blocked' by children 1+2 (now in_review); I also added the missing dependency edges (child3 depends on child1 and child2) so parent recursion orders correctly. The parent plan had these dependencies in prose only.

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 9 — SA-0MVNPSBEJ006Z59T

- **Root:** `/home/rgardler/projects/SorraAgents`
- **Title:** Standup: separate auto-dispatched from manually dispatched items in 'Yesterday I completed work on...'
- **Deciding evidence:** `comment:SA-C0MWG935ZP003GX87`
- **Flag age:** 11d 5h

**Question**

> question: Producer approval required for the planned decomposition — the plan-approval gate fired because this item has no effort/risk estimate (conservative default: a human checkpoint is never silently skipped).
>
> ## Proposed plan (3 children, all parent ACs covered)
>
> 1. **SA-0MWG1KOHZ005Q57L** (task) — Implement classify_auto_dispatch(): dispatch-log + comment-marker classification with graceful degradation. Covers parent AC5 (fixture tests) + AC6 (read-side failures degrade gracefully, exit 0).
> 2. **SA-0MWG8UM41000F0Y9** (task) — Implement Yesterday split in report pipeline: markdown sub-groups (auto first, then manual), --json yesterday_auto/yesterday_manual (+_count) with unchanged yesterday/yesterday_count/yesterday_tts contract, first-person TTS split. Covers parent AC1, AC2, AC3, AC4.
> 3. **SA-0MWG8UPTU008VIY3** (docs) — Document the split, provenance rule, default-to-manual, kind:scheduled decision and new --json fields in skill/standup/SKILL.md. Covers parent AC7.
>
> Parent AC8 (existing tests green + hermetic new tests) is a quality gate enforced by the implement/test workflow and is embedded in children 1 and 2's test ACs. The tree-coverage review's auto_close recommendation (AC7/AC8 fuzzy low scores) is a matcher artefact — both are substantively covered.
>
> ## Provenance signal (already exists — no new mechanism)
>
> - .worklog/downtime-dispatches.log (rolling 100-entry JSONL): itemId + outcome != spawn-failed → auto; also kind:scheduled counts as auto (documented decision).
> - Worklog comment prefix 'Auto-dispatched by the herdr downtime worker at' → auto (durable fallback after log trim).
> - Default to manual when no marker (fail-open to the smaller bucket); downtime-coordination.log / local-route.log are NOT markers.
>
> Please approve, edit, or reorder via reply. While awaiting approval the item is held in_progress (downtime-run gate per plan skill) — no implementation will be dispatched.

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 10 — SA-0MVQKMGGN0091NAR

- **Root:** `/home/rgardler/projects/SorraAgents`
- **Title:** plan-if-needed overwrites operator-confirmed effort/risk
- **Deciding evidence:** `comment:SA-C0MWG8SP9K000Q2EW`
- **Flag age:** 11d 5h

**Question**

> question: Intake interview — planning to draft the brief for this bug, but the fix
> mechanism has three genuine forks that need operator input. Research below, then
> questions.
>
> ## Research summary (established, no answer needed)
>
> - **Incident mechanism (from worklog evidence):** on SA-0MVL2NH1G0094FA2 the
>   operator confirmation ("Effort M / risk High carried over from the OSL intake",
>   2026-10-23 comment) was recorded **in a comment**, and the effort/risk **fields
>   were empty** when `plan-if-needed` ran on 2026-10-27 09:38. Proof: the estimator
>   ran at all — `is_effort_risk_computed` returns True whenever **both** fields are
>   non-empty, so the fields cannot have held High/M. The estimator then wrote
>   Extra Small/Low via `orchestrate_estimate.py::_update_work_item`
>   (`wl update --effort --risk` — it blindly overwrites), and Map manually
>   restored the fields to High/M (restore comment SA-C0MVQKM7XD0089OVQ).
> - **Residual gaps in current code** (the zeroed-placeholder root cause is already
>   fixed by SA-0MW0LPXXY0002CQ0, and the fetch-failure corruption by
>   SA-0MSIUJQAK008AQV8):
>   1. *Comment-only confirmation:* fields empty + comment confirms values + the
>      item HAS estimable inputs (children with effort labels) → the derived
>      estimate is written over the confirmation.
>   2. *Partial-set:* only one field deliberately set (e.g. effort=M, risk empty) →
>      `is_effort_risk_computed` is False (needs BOTH) → the estimator overwrites
>      the deliberately-set field.
>   3. *No warning surface:* when the estimator does run, it replaces existing
>      field values with no warning/approval.
> - **Duplicate check performed:** no full duplicate. Overlapping (related, both
>   completed): SA-0MW0LPXXY0002CQ0 (zeroed payload), SA-0MSIUJQAK008AQV8
>   (fetch-failure corruption). Origin: SA-0MVL2NH1G0094FA2.
>
> ## Questions
>
> ### Q1 — What counts as "an explicitly set/human-confirmed" value (recognition mechanism)?
>
> - (a) **Fields + provenance:** any stored effort/risk value is *deliberate* unless
>   it is attributable to a prior estimator run (an `effort_and_risk_skill` comment
>   or `autoplan-decision-hash` marker explains it). Empty fields → estimator may
>   run. Does NOT protect comment-only confirmations (the exact incident shape).
> - (b) **Fields + intake-side recording:** (a) plus a convention that operator
>   confirmations (e.g. carry-over values like the incident's) are written into the
>   fields at confirmation time, so the existing fields gate protects them. Closes
>   the incident end-to-end; touches intake/plan flows as a small convention change.
> - (c) **Fields + comment marker:** (a) plus recognising a new explicit marker
>   (e.g. `operator-confirmed-effort:M`, `operator-confirmed-risk:High`) in comments.
>
> **Recommended: (b)** — writes confirmations where the gate already looks (the
> fields), avoids fragile comment parsing, and fixes the exact incident shape.
>
> ### Q2 — Remediation when a genuine recomputation would overwrite a deliberate value (AC1's "or")?
>
> - (a) **Gate:** skip the recomputation entirely and record the rationale
>   (dedicated comment/log entry); the deliberate value stays.
> - (b) **Surface:** post an explicit warning comment and refuse to overwrite
>   without explicit confirmation (e.g. operator-approved `--force` / approval gate).
> - (c) **Both:** gate by default; `--force` escape hatch that surfaces the warning
>   and requires confirmation before overwriting.
>
> **Recommended: (c)** — gate by default (plan-if-needed runs in automation with no
> interactive approval channel), with an explicit, approval-gated opt-out for
> genuinely needed recomputations.
>
> ### Q3 — Regression-test coverage for AC2 (test must be RED before the fix to be meaningful)?
>
> - (a) **Exact incident shape:** operator confirmation present (per Q1's chosen
>   mechanism), no prior estimator comment → value preserved.
> - (b) **Partial-set shape:** only one field deliberately set → the set field is
>   preserved.
> - (c) **Both (a) and (b).**
>
> **Recommended: (c)** — both, matching AC1's "an explicitly set/human-confirmed
> effort OR risk" (per-field protection).

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 11 — SA-0MVSCS0M80007X23

- **Root:** `/home/rgardler/projects/SorraAgents`
- **Title:** Rework 5 source-grep style tests in test-check-audit-gate.mjs
- **Deciding evidence:** none (no surviving evidence)
- **Flag age:** unknown

**Question**

> does it still need producer attention?

**Recommended:** confirm whether it still needs producer attention — no deciding evidence survives, so only you can say whether the flag is still needed (advisory only)

#### Row 12 — SA-0MVXVC9FM003ZJKJ

- **Root:** `/home/rgardler/projects/SorraAgents`
- **Title:** Measure per-test runtime and flakiness to quantify test value per second
- **Deciding evidence:** `comment:SA-C0MWINOVMJ0081RHI`
- **Flag age:** 9d 13h

**Question**

> question: 1. **Per-test timing capture mechanism** — For pytest, should we use the ``pytest_runtest_makereport`` hook to record per-test durations, or a wrapper around the test collection? For Vitest, should we use the ``onTestFileStart/onTestFileEnd`` reporter hooks or ``onTestResult``? 2. **Flake history storage** — What retention policy? E.g. keep the last N runs per test (10? 50?), or time-based (keep for 30 days)? Should flake history be stored alongside the existing cache entries or in a separate file? 3. **Machine-readable report format** — JSON with per-test fields (file, name, duration_seconds, pass_count, fail_count, flake_count, last_seen)? 4. **Overhead budget** — What is the acceptable overhead? Adding per-test timing adds small overhead (<1ms per step with the shared Timer class). Is <1% overhead acceptable?
>
> These are the key implementation decisions that need producer sign-off before proceeding to planning.

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 13 — SA-0MW5KKEHL005BR0L

- **Root:** `/home/rgardler/projects/SorraAgents`
- **Title:** Refactor skill: REFACTOR markers cross-wired and added without a fix
- **Deciding evidence:** `comment:SA-C0MWL5PUW4007DAYU`
- **Flag age:** 7d 19h

**Question**

> question: (Q1, producer decision) The item's second expectation says "a marker must only accompany an actual fix (or explicitly document why no fix is applied)". Refactor markers are injected for pre-existing, *unfixed* smells by design. Which reading applies?
>
>   (a) [Recommended] Keep injecting markers for unfixed smells, and add a `state: pre-existing, not fixed` line to the marker block so a marker-only hunk is self-documenting. Smallest change; keeps the duplicate-suppression signal.
>   (b) Stop injecting markers into files the run did not modify (markers only for session-scoped scans, or only for files the auto-fix step touched). Larger behavioural change; removes duplicate suppression for full-project scans.
>   (c) Keep markers unchanged and rely on the run report/commit message to state that markers accompany no fix.
>
> Recommended: (a) — see the intake brief's Appendix Q1 for rationale. Intake is complete and the brief/ACs proceed on (a); option (b) is reachable by dropping AC4 and gating injection on the modified-file set. Research summary: design intent in skill/refactor/comment_injection.py ("track pre-existing") and skill/refactor/SKILL.md; root-cause mis-pairing already fixed by b05cbad554 (SA-0MWE1E4GQ004E1JG), so the remaining scope is regression coverage + a write-time identity guard.

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 14 — SA-0MWAXZHOU000UBG1

- **Root:** `/home/rgardler/projects/SorraAgents`
- **Title:** Audit full-suite cache check still uses the loose worktree key after the pre-push gate became tree-keyed
- **Deciding evidence:** `comment:SA-C0MWJ3PXQC008QPZY`
- **Flag age:** 9d 5h

**Question**

> Plan proposal for SA-0MWAXZHOU000UBG1 — awaiting producer approval.
>
> ## Seed context
> Bug: the audit _classify_full_suite_cache() queries the per-repo test cache with the loose HEAD+dirty-worktree fingerprint (query_cached(command, cwd=project_root)) and so can never see the tree-keyed full-suite entry (fingerprint_kind="tree") the dev-push pre-push gate now records (SA-0MW7C6BMZ00931JG). Result: every audit treats a green full-suite gate run as a cache MISS and F3 auto-executes the suite on every audited item. Fix mirrors SA-0MWAXC5TD00461FN (query_cached already accepts fingerprint + fingerprint_kind).
>
> ## Plan (3 children, test-first order, deps wired)
> 1. SA-0MWJ2964X0079ZPF (test) — tree-keyed green entry accepted by _classify_full_suite_cache.
> 2. SA-0MWJ2BRC9006U644 (test) — tree-keyed mismatch rejected; loose fallback works.
> 3. SA-0MWJ3N491004UCOL (fix) — resolve audited HEAD tree, query tree-keyed first, fall back to loose for legacy entries (scope==full filter + read-only mandate preserved). Depends on 1 and 2.
>
> ## Why approval is requested
> The plan-approval gate defaulted to requesting approval because the item has no effort/risk estimates (a human checkpoint is never silently skipped). Please accept, edit, reorder, or split/merge the plan, then planning resumes with the six automated review stages and AC coverage review.
>
> ## Appendix
> - OPEN QUESTION (producer): approve the proposed feature plan above? Recommendation: accept as-is — the fix mirrors the already-shipped SA-0MWAXC5TD00461FN pattern (query_cached fingerprint + fingerprint_kind="tree", loose fallback, scope==full filter preserved), with two focused test tasks pinning tree-keyed lookup and legacy fallback.

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 15 — SA-0MWROFAG800719G4

- **Root:** `/home/rgardler/projects/SorraAgents`
- **Title:** Driven child in a foreign-project worktree cannot resolve its owning worklog store
- **Deciding evidence:** `comment:SA-C0MWROFKMI003FIDJ`
- **Flag age:** 3d 5h

**Question**

> question: Intake needs a producer decision — **which proposed fix (A/B/C) should be implemented?**
> - **(A)** `wl` env fallback for `--worklog-dir` (flag > env > cwd) + `implement.py` exports the per-child resolved store — cross-repo, documented, testable, no filesystem magic.
> - **(B)** Per-worktree store pointer in `phase_start` — SorraAgents-only, filesystem magic, guard risk.
> - **(C)** Documentation-only manual fallback — does not fix the failure.
> **Recommended\:** (A). Effort/risk deferred until the option is chosen.

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

### `/home/rgardler/projects/tce-the-rising` (2 rows)

#### Row 16 — RISE-0MWMS0TAN008G2SY

- **Root:** `/home/rgardler/projects/tce-the-rising`
- **Title:** Slow down Face Offs
- **Deciding evidence:** `comment:RISE-C0MWMSPLPT002T2L6`
- **Flag age:** 6d 15h

**Question**

> **Intake questions for the producer (3)** — the brief is drafted against the recommended answers; Q1/Q2 are marked OPEN QUESTION in its Appendix.
>
> **Q1 — Which "pause phases" should double?** The request says "double the time spent in each pause phase of animations".
> - **A (Recommended)** — double the named pauses only: `RISING_ATTACK_STAGE_GAP` 250→500, `RISING_EXCHANGE_PAUSE` 150→300, `RISING_END_ROUND_REVEAL_HOLD` 1,400→2,800, growing the per-slot read interval only as far as a pair's beat needs (1,800→2,800, since the attack beat becomes 1,960 ms). Motion beats unchanged; full cascade ≈11.2 s → ≈17.6 s.
> - **B** — double everything (pauses *and* every motion beat: interval 3,600, reveal 1,200, exchange cadence, crumble 1,000); cascade ≈21.6 s+, duels ≈2× longer.
> - **C** — double the pauses and the per-slot read interval in full (interval 3,600, hold 2,800, gaps 500/300); motion beats unchanged; cascade ≈21.6 s.
> **Recommended: A** — the ×2 lands on every genuine pause without also doubling travel/tween beats, and keeps a full cascade under ~18 s.
>
> **Q2 — What should each floating label say?**
> - **A (Recommended)** — one label per card per **clash**, showing the total strength that card lost (e.g. loser `-4`, attrited winner `-2`); no label when a card lost nothing.
> - **B** — one label per card per **exchange** (loser `-1` each exchange, winner its attrition share) — more labels, follows the duel cadence.
> - **C** — only the loser's label.
> **Recommended: A** — "the damage done to each card" reads as one statement per clash and stays legible at a glance; B would strobe at the 200 ms exchange floor.
>
> **Q3 — Reduced motion?**
> - **A (Recommended)** — suppress the labels under reduced motion (panel + badge repaint already carry the information; matches `popTextOrIcon`).
> - **B** — show them statically (no rise/fade) for a fixed hold.
> **Recommended: A** — consistent with every other reduced-motion beat.
>
> Additionally: is editing the `core` submodule's `core/src/ui/popTextOrIcon.ts` acceptable for the large-label style, or is a local wrapper in `src/` preferred? (Recommendation: local wrapper in `src/` — no submodule change.)

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)

#### Row 17 — RISE-0MWTXTO86004BKXJ

- **Root:** `/home/rgardler/projects/tce-the-rising`
- **Title:** When a place/event/mission card is played on a stack the tooltop should show the details
- **Deciding evidence:** `description:RISE-0MWTXTO86004BKXJ:OPEN_QUESTION`
- **Flag age:** unknown

**Question**

> ## Open questions (blocking)
>
> **Q1 — What are "place", "event" and "mission" cards?**
>
> - **A.** Existing kinds: "place" = a figure card placed in a timeline slot;
>   "event" = a moment card; "mission" = no equivalent in this game, so the title
>   needs re-wording.
> - **B.** New card types: place and mission are planned kinds that do not exist
>   yet; this item is blocked by a new-card-type design/implementation item.
> - **C.** Generic wording: the title means "any card", and the work is only the
>   observed gap (a moment attached to a figure is not described in its tooltip).
>
> **Recommended\:** C — it is the only interpretation backed by the codebase; A
> still leaves "mission" unexplained and B needs a separate design first.
>
> **Q2 — What "details" should appear on the tooltip?**
>
> - **A.** The full details of the card played onto the stack, appended to the
>   host card's tooltip (for a moment: title, full text, figures, value and
>   polarity).
> - **B.** A compact one-line summary (e.g. `Moment: <title> (+1 strength)`).
> - **C.** Full stack membership plus the details of every attached moment.
>
> **Recommended\:** A — matches the existing "all the information about the card"
> contract and keeps the tooltip self-contained.
>
> **Q3 — Is this presentation-only?**
>
> - **A.** Yes: tooltip composition, renderer wiring, tests and docs; no
>   rules/state/save-schema change.
> - **B.** Also change rules/state (e.g. persist attachment metadata).
>
> **Recommended\:** A — the attachment already exists in state
> (`surfacing.momentId`), so only presentation is missing.

**Recommended:** answer the question, then clear the flag — the deciding question on record is still unanswered — I cannot answer it for you (advisory only)
