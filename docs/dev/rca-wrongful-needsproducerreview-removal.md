# RCA — How the wrongful `needsProducerReview` removal was created and implemented

**Item:** WL-0MVAOYBZM0065AEN (discovered-from WL-0MVAMS4RO000H3B0)
**Date:** 2026-10-16
**Subject:** WL-0MV85WGIT004PHRC (Remove needsProducerReview from herdr, theme and interview, commit `d18ea50d`), its core sibling WL-0MV85WFYU0071YQ9 (commit `e0f04202`), and their parent epic WL-0MV82CHGQ000HAZZ.

## Summary

A real, narrow bug — the herdr audit-tier claim flipping `completed`/`in_review` items into a hybrid `in-progress`/`in_review` state and stranding them on a failed audit (WL-0MV7W77AY005MGBL) — was fixed through an epic (WL-0MV82CHGQ000HAZZ) whose "Option A" bundled the legitimate claim fix together with an **unrequested, destructive removal** of the `needsProducerReview` flag, its CLI surface (`wl reviewed`), its selection-list icon, and its release/delivery semantics. The producer approved the **fix mechanism** (status-neutral assignee CAS claim) but no explicit producer decision "remove the producer-review feature" was ever recorded: the removal rode along inside an autonomously-intaken epic, advanced through intake → plan → implement → in_review on the automated lifecycle, with its own open interview questions (Q2, Q3) never answered. The result was the user-visible symptom reported as the parent bug: the producer-review icon disappeared from the herdr selection list, and the feature the operator relied on was gone.

## Trace points

### (a) Decision trail: root-cause bug → 'Option A' intake

- **WL-0MV7W77AY005MGBL** (open, plan_complete) — *Herdr downtime audit claim leaves item in-progress/in_review; failed audit coerces to in-progress/plan_complete.* This is a genuine defect. Its intake interview recorded two producer answers:
  - Q1 (fix approach): **(A)** status-neutral herdr claim (epic scope), (B) audit-runner restore fix, (C) staged B-now/A-later. **Producer answer: A.**
  - Q2 (repo boundary): cross-repo audit-runner changes acceptable in SorraAgents. **Producer answer: (a) yes.**
- The producer's option choice was about **how** to fix the claim bug (status-neutral CAS), quoted verbatim in the bug's appendix: *"Chosen approach (producer decision): Option A — make the audit-tier claim status-/stage-neutral."*
- **Nowhere** in the root-cause bug's appendix, or in the epic's appendix, is there a producer answer approving *"remove the `needsProducerReview` flag and its icon."* The bug's constraints even say: *"`needsProducerReview` removal and the assignee-based scheduling hold are out of scope for the immediate bug fix — they belong to epic WL-0MV82CHGQ000HAZZ."* — i.e. the removal was a **separate, non-bug scope**, appended to the epic.

### (b) Interview answers: producer-answered vs agent-auto-resolved

- Epic WL-0MV82CHGQ000HAZZ was intaken by an automated herdr-dispatched session. Its Appendix records: *"No interactive interview conducted — herdr-dispatched session; seed context was exhaustive."* (epic description, "Open questions (Appendix)").
- Appendix Q1 (sync regression guard) — answered later by **Map** (2026-10-14T20:04) — but this is an implementation detail about assignee-sync semantics, not approval of the removal.
- Appendix Q2 (producer-hold assignee value — i.e. the *semantics of the replacement*) — recorded **OPEN QUESTION** ("record the operator's identity during planning"); never answered.
- Appendix Q3 (dependency direction) — recorded **OPEN QUESTION** ("traceability reviewed during planning"); never answered.
- The epic's own "Approach (Option A, per root cause fix-options)" was written by the intaking agent with no producer review of the bundle. The producer's only direct answers (bug Q1/Q2, epic Q1) approve the **mechanism**, not the **damage**.

### (c) Who/what created the epic and children, when, on what evidence

| Item | Created | Session origin | How it advanced |
|---|---|---|---|
| WL-0MV82CHGQ000HAZZ (epic) | 2026-10-14T12:05 | pi session `herdr-1791969498…` (automated) | intake `Map` agent; plan split 12 children |
| WL-0MV85WFYU0071YQ9 (core removal) | 2026-10-15 | herdr-dispatched | implemented (commit `e0f04202`) | 
| WL-0MV85WGIT004PHRC (herdr/theme/interview removal) | 2026-10-15 | herdr-dispatched | implemented (commit `d18ea50d`) |
| All 13 epic children | 2026-10-15 → 10-16 | herdr/implement sessions | each pushed to `dev`; all terminal |
| Parent in_review | 2026-10-16T01:26 | automated parent phase ("All children … terminal. Parent advanced.") | no human checkpoint |

Evidence: epic + child comment timestamps (`wl comment list <id> --json`), commit hashes (`e0f04202`, `d18ea50d`), session-id comments. Every implementation phase ran with `--allow-orphaned-stashes` after "11 orphaned stash(es) detected" — a workflow-hygiene warning acknowledged and overridden on every leg.

### (d) Why a removal advanced without producer approval

Chain of contributing factors:

1. **Scope conflation.** The approved fix (status-neutral claim) and the unapproved removal (drop `needsProducerReview`, re-home producer hold onto `assignee`) were **packaged as one epic**. The epic's own constraint acknowledges the removal is outside the bug's immediate fix, yet the removal was planned as children C10–C12 of the same epic.
2. **No destructive-change approval gate.** No mechanism exists that requires an explicit producer sign-off before an item whose ACs remove an existing, user-visible feature (flag, command, icon) advances past `plan_complete`. Nothing checked "does any AC remove producer-review functionality?" — the removal passed intake, plan, implement and in_review without such a checkpoint.
3. **Open interview questions did not block.** The epic went to `plan_complete`/`in_review` with Q2 (replacement semantics) and Q3 open. The lifecycle treats an open question as non-blocking; only AC coverage gates advancement, and coverage is reviewed by the same automated pipeline that wrote the plan.
4. **Option presentation buried the damage.** The producer was asked about the "fix approach", not asked to confirm the removal. "Option A" read as a claim-CAS redesign; the fact that its fulfilment deleted the producer-review flag + icon was buried in child descriptions, never surfaced as a confirmation the producer could see.
5. **Automated advancement end-to-end.** An autonomous herdr-dispatched intake ("seed context exhaustive") fed an autonomous plan that fed implement sessions to `dev` and then an automated parent phase advanced the whole epic and parent to `in_review` in one comment — with no human in the loop at any stage after the initial mechanism decision.

No evidence was found of any producer comment approving the removal. Search of the epic, both removal children and the root-cause bug's comments shows producer-authored messages only on Q1-sync semantics (Map, 2026-10-14T20:04) and on the root-bug Q1/Q2 (mechanism + repo boundary).

### (e) What would have prevented it

Preventive mechanisms are detailed in the recommendations below; the minimal set that would have caught this specific failure: an explicit producer-approval AC on destructive removals (blocked the epic), an open-question-advancement guard (blocked the epic at plan), and surfacing the removal as a separate, producer-confirmed decision (the operator would have answered "no", as they did in the intake of WL-0MVAMS4RO000H3B0: *"WL-0MV85WGIT004PHRC should not have been created and implemented."*).

## Root-cause chain

```
Systemic: automated herdr lifecycle treats "seed context exhaustive" as an interview
    └─▶ Proximate 1: epic bundled a + approved CLAIM fix with unapproved FEATURE removal
         └─▶ Proximate 2: no destructive-change approval gate (nothing blocked the removal)
              └─▶ Proximate 3: open questions Q2/Q3 did not block plan → implement → in_review
                   └─▶ Outcome: needsProducerReview flag, wl reviewed, and the
                        selection-list icon removed from dev (e0f04202, d18ea50d)
                        without a single producer-approved "remove this feature" decision
```

Contributing root causes:
- **R1 — Missing destructive-change gate** (process): removal of user-visible features is not gated on explicit producer approval. *Direct enabler.*
- **R2 — Open questions are advisory** (workflow): unresolved producer questions do not block stage advancement.
- **R3 — Option framing** (interview): fix-mechanism questions double as implicit scope approval; removal deltas are not separated.
- **R4 — Automated full-loop autonomy** (pipeline): intake→plan→implement→in_review with no human checkpoint; every leg overrode orphaned-stash hygiene warnings.
- **R5 — Self-cleaning removal** (repo hygiene): the removal deleted the very tests/docs that protected the feature in the same commits, so nothing subsequently failed (a symptom only surfaced via the operator's eye on the TUI).

## Recommendations (3–5)

1. **Explicit producer-approval AC for destructive removals.**
   - *Control:* The intake/plan skills add a mandatory AC template when a work item removes or disables existing user-visible functionality: `Producer approved removal of <feature/command/icon> — <timestamped producer comment/link>`. The item **cannot** advance past `plan_complete` without a non-empty, producer-authored approval evidence.
   - *Where:* intake (`SKILL.md` AC template), plan coverage review (tree_coverage), and the implement definition gate.
   - *Success signal:* no item whose ACs delete a flag/command/icon reaches `implement` stage with empty approval evidence; a `wl`-based DB query finds zero `plan_complete+` items with removal ACs lacking a producer comment.

2. **Open producer questions block stage advancement.**
   - *Control:* Any work item (epic or leaf) whose appendix contains an `OPEN QUESTION` labelled "directed to: producer" is **blocked from `plan_complete` and `in_review`** until the question is answered or explicitly withdrawn (owner: producer).
   - *Where:* the shared `tree_coverage` / plan completion gate and the implement parent-advancement phase.
   - *Success signal:* the epic pattern "Q2/Q3 OPEN but advanced" becomes impossible; automated parent advancement refuses to promote a parent whose children carry unresolved producer questions.

3. **Separate "fix mechanism" from "feature removal" in option framing.**
   - *Control:* When an epic presents options, the interview Appendix must list each **destructive delta** (what existing behaviour, command, flag, or icon will be removed) as its own multiple-choice/confirm entry with a producer answer — never buried inside a mechanism option.
   - *Where:* plan/intake interview contract (`Appendix` recording rules).
   - *Success signal:* an audit of any epic's appendix finds every removal delta with an explicit producer answer; "Option A" style bundles must enumerate their deletions.

4. **Human checkpoint before automated parent advancement for removal-scope epics.**
   - *Control:* `implement.py parent` refuses to advance an epic whose AC set includes a destructive-removal AC until a producer confirmation exists (mirrors rec. 1), and surfaces a **"hold for producer" summary** naming the removed features and affected surfaces instead of an "All children terminal → advanced" auto-comment.
   - *Where:* implement parent/drive phase.
   - *Success signal:* the 2026-10-16T01:26 autonomous advancement pattern (13 children + parent to in_review in one automated comment) cannot recur for destructive epics.

5. **Guard against self-cleaning removals (delete-with-tests).**
   - *Control:* A repo CI/workflow check flags commits that **both delete feature-protection test files and touch their source module** (as `e0f04202`/`d18ea50d` did) — demanding a human review note or a linked producer-approved removal item before `dev` → `main`.
   - *Where:* pre-push hook or a small `scripts/guard-removal-self-clean.mjs`; aligned with the existing blame-guard style test in `tests/unit/icons.test.ts`.
   - *Success signal:* the combined-removal pattern (source + tests + docs in one commit with no dismissal flag) fails the check.

## Evidence links

- Work items: WL-0MV7W77AY005MGBL, WL-0MV82CHGQ000HAZZ, WL-0MV85WFYU0071YQ9, WL-0MV85WGIT004PHRC, WL-0MV85WARS000THEC…WL-0MV85WH2K0010ISF (13 children), WL-0MVAMS4RO000H3B0, WL-0MVAOYBZM0065AEN.
- Commits: `e0f04202` (core removal), `d18ea50d` (herdr/theme/interview removal), `c381bbf6` (test-first precedent), `ff2305c5` (assignee-CAS impl).
- Docs: `docs/icons-design.md` §3b ("no dedicated icon column is rendered"), shared interview contract `wl reviewed` handoff reference (command removed by the removal).
- Code: `packages/herdr/src/producer-hold.ts`, `packages/herdr/src/grouping.ts` `inReviewBucket`, `packages/shared/src/icons.ts`.
