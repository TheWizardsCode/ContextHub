# Duplicate-dispatch post-fix verification (WL-0MUBVL5770009DO9 / F7)

Verification record for parent **WL-0MUBEZ6PE002WLP4** — *RCA: Downtime dispatcher
re-dispatches CRITICAL implement items*. Covers F7 AC-V1/AC-V2/AC-V3 for the fix
features F1–F6.

## Fix under test

| Feature | Item | Commit |
| --- | --- | --- |
| F1 — RCA / RED witness | `WL-0MUBVKPLP006RRDJ` | `9255d931` |
| F2 — Regression suite | `WL-0MUBVKS5I007LSWB` | `46b61ae0` |
| F3 — In-flight guard (Herdr-head + normal) | `WL-0MUBVKXQJ000L8EO` | `7bc744d4` |
| F4 — In-flight guard (coordination) | `WL-0MUBVKYH5009CGBI` | `3dcf3555` |
| F5 — Atomic rolling-log writes | `WL-0MUBVL1FI0071WN3` | `7bfd23ef` |
| F6 — Log selection path + pane id | `WL-0MUBVL251006JAQ0` | `a3a15e77` |

All commits are on `dev`. **The fix-deploy timestamp for the live dispatcher is the
plugin reload that picks up `dev`** (the dispatcher runs the linked ContextHub
plugin); until that reload a running dispatcher executes pre-fix code.

## Method (repeatable)

```bash
# Full historical scan over the five host roots
python3 packages/herdr/scripts/scan_duplicate_dispatches.py --json

# Post-fix window: only entries dispatched at/after the fix commit
python3 packages/herdr/scripts/scan_duplicate_dispatches.py \
  --since 2026-09-22T11:01:55Z --json

# Narrow to the actual fix-deploy moment (plugin reload), once known
python3 packages/herdr/scripts/scan_duplicate_dispatches.py --since <fix-deploy-iso> --json
```

Roots (defaults in `scan_duplicate_dispatches.py`): `ContextHub`, `SorraAgents`,
`Tableau-Card-Engine`, `dev-scripts`, `open_source_llm`.

The scan now **excludes `enrichment: true` entries** (F6 post-spawn enrichment,
which copies the marker fields and is not a second dispatch) and reports
`selectionPaths` / `selectionReasons` / `paneIds` per duplicate pair.

## Results

### Full historical scan (no `--since`)

38 duplicate `(kind, itemId)` pairs, **all first dispatched before the fix
window** (oldest 2026-09-16, newest 2026-09-21). This is the pre-fix defect
population; none are new.

### Scan from F1 commit (`--since 2026-09-22T08:29:33Z`)

**1 pair** — `Tableau-Card-Engine` / `plan` / `CG-0MUCERZVO00236D2` (2 entries,
09:25:48Z and 10:28:37Z), empty `selectionPaths`/`paneIds` (written by pre-F6
code):

- The item is `critical`, observed `open` at `plan_complete` — consistent with the
  confirmed H1+H5 mechanism.
- **Both dispatches predate the F3 fix commit (11:01:55Z)**, and the running
  dispatcher had not been reloaded with F3 — i.e. it was executing pre-fix code.
  The entries' missing `selectionPath` corroborates that (they were written
  before F6 existed). This pair is therefore **not** evidence against the fix.

### Scan from the F3 fix commit (`--since 2026-09-22T11:01:55Z`)

```json
{
  "roots": [
    "/home/rgardler/projects/ContextHub",
    "/home/rgardler/projects/SorraAgents",
    "/home/rgardler/projects/Tableau-Card-Engine",
    "/home/rgardler/projects/dev-scripts",
    "/home/rgardler/projects/open_source_llm"
  ],
  "duplicates": []
}
```

**Zero new duplicate pairs** for the dispatch kinds touched by F3–F6.

### Scan from the final fix commit (`--since 2026-09-22T11:47:04Z`)

**Zero** duplicate pairs.

## Known limitation (AC-V1 honesty)

A live **post-plugin-reload** window cannot be observed from inside this
implementation session: the running downtime dispatcher had not yet restarted
onto the fixed `dev` code, and the incident root (`LP-*`) is not present on this
host (established by F1). The verification above uses the fix **commit** as the
window bound; once the plugin is reloaded onto `dev`, re-run the `--since
<fix-deploy-iso>` command to confirm the same zero result over the deployment
window. The in-process/unit guarantee is already proven by the suite below.

## Suite status (AC-V2)

```
npx vitest run packages/herdr
→ Test Files  65 passed (65)
  Tests  2385 passed (2385)
```

- F1's RED witness (`RCA: critical in-flight re-dispatch …`) was committed as
  `it.fails` pre-fix and flipped to `it` by F3 — observed RED pre-fix
  (`OBSERVED_SPAWN_COUNT=2`), GREEN after.
- F2's regression suite (both dispatch paths) is GREEN after F3+F4.
- The full root suite is additionally gated by `implement.py finish`
  (build → changed-scope → full-suite → commit → push) on each fix commit.
