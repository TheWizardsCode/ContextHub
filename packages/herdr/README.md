# Worklog Selection List — Herdr Plugin

A Herdr plugin that provides a keyboard-navigable work item selection list for browsing, filtering, and selecting [Worklog](https://github.com/your-org/worklog) work items from within Herdr.

## Features

- **Browse work items** — Lists work items from `wl next` in a scrollable, keyboard-navigable list. The top-level list is root-only: child work items are hidden and appear only under their parent via expand.
- **Filter by stage** — Press `f` followed by a chord key (`i`=idea, `n`=intake, `p`=plan, `r`=review) to filter items by stage
- **View details** — Press Enter on any item to see its full details (description, acceptance criteria, metadata, tags, priority, GitHub issue number, and audit status information such as audit result, review status, and last audit timestamp)
- **Audit indicators** — The list view shows audit icons next to `in_review` items (✅ audited, ❌ failed, ❓ unaudited). The detail view metadata section additionally shows the review status (❌ needs review / ✅ reviewed) and the last audit timestamp.
- **Chord shortcuts** — Multi-key chord sequences provide quick actions like updating priorities, stage/status, title, closing/deleting items, running workflows, and toggling review status (configurable via `shortcuts.json`)
- **Command output** — When a chord resolves to a non-`/wl` command (e.g., `!!wl update <id> --priority high`), the resolved command is executed **visibly in a new herdr pane** (see `scripts/run-in-pane.sh`) so the user sees the command line and its output; the wrapper keeps the pane's process alive so the pane stays open for inspection — dismiss it with Enter or close it with `prefix+x`
- **Command input form** — When a chord command contains unknown `<identifier>` placeholders (e.g. `!!wl update <id> --status <status> --stage <stage>`), the plugin shows a modal input form so you can fill in the values before the command runs. Known identifiers like `<id>` are still auto-substituted with the selected item's ID. The dialog is 80% of the pane width (40-column minimum), text wraps at the inner width, and the box grows downward as content is entered. See [Command input form](#command-input-form).
- **Keyboard navigation** — Arrow keys or j/k to navigate (wraps at list boundaries), Page Up/Down, g/G for first/last, Enter to select, Escape to go back
- **Pi agent pane dispatch** — Agent commands (`/skill:*`, `/intake`, `/plan`) are automatically dispatched to a new pi agent pane opened to the right, where pi receives the command as its initial prompt. Free-form prompts use the `/prompt:` prefix: the routing prefix is stripped so pi receives only the prompt text.
- **Open Pi Agent action** — The plugin provides an action to open a fresh interactive pi session pane
- **Tab-based opening** — The worklist opens in a new tab in the current workspace, providing full-screen access without reducing space for existing panes
- **Quit** — Press `q` to exit
- **Metadata panel** — The bottom portion of the list view (roughly 20–40% of the pane height, responsive to terminal size) is reserved for the selected item's metadata: ID, title, status, stage, priority, type, risk, effort, tags, audit info, and more. The panel scrolls independently with `m`/`M` (down/up) so long metadata never affects list navigation. See [Metadata panel](#metadata-panel).
- **Command log** — Every plugin-dispatched command that targets a work item (via `<id>` substitution or an explicit item ID) is recorded to a local JSON log. For `in_progress` items the panel shows the **last command** at the bottom, so you can see exactly what was last dispatched against the item. See [Command log](#command-log).
- **Stage grouping** — Work items are grouped by their Worklog stage (standard lifecycle stages only: `idea`, `intake_complete`, `plan_complete`, `in_progress`, `in_review`, `done` — no custom stage values). Podcast episode items group exactly as their frontmatter stages map 1:1 (PRD §7.2). See [Stage grouping](#stage-grouping).
- **Generic md viewer** — When a work item's description carries a `Key Files:` path to a markdown document (e.g. a podcast episode `.podcast.md`), the detail view renders the file with a generic markdown viewer (frontmatter skipped, headings/lists/code shown) as a preview. See [Markdown viewer](#markdown-viewer).
- **Inline note links** — Inline `[NOTE <id>: ...]` markers (PRD §7.1) render as clickable links to the note work items: the marker is displayed as `<id>↗`, and the note text is never shown in the viewer. See [Inline note links](#inline-note-links).
- **Code Freeze awareness** — While a ship-it release is in progress the project is in *Code Freeze*: the worklist shows a prominent banner and blocks all implement commands (`/skill:implement*`) with a notice dialog until the release finishes. See [Code Freeze](#code-freeze).

## Requirements

- [Herdr](https://herdr.dev) v0.7.0 or later
- [Worklog CLI (`wl`)](https://github.com/your-org/worklog) installed and on PATH

## Installation

### From source (development)

```bash
# Clone the repository
cd /path/to/worklog-repo

# Link the plugin in Herdr
herdr plugin link packages/herdr/herdr-plugin.toml

# Build the plugin
cd packages/herdr && npm run build
```

The plugin pane will then be available via the Herdr plugin system.

## Usage

### From the Herdr UI

1. Open the worklist pane:
   - Press `prefix+l` to open the worklist in a new tab
   - Right-click in any pane → Plugins → Worklog Selection List → Open worklist
   - Or use the Herdr command palette: `herdr plugin action run worklog-selection-list open-worklist`

2. Navigate the list:
   - `↑`/`k` — Move up (wraps to last item when at top)
   - `↓`/`j` — Move down (wraps to first item when at bottom)
   - `PgUp` — Page up
   - `PgDn` — Page down
   - `g` — Go to first item
   - `G` — Go to last item (last visible item in expanded hierarchy)
   - `Enter` — View item details, or expand a parent item with children
   - `Tab` — Toggle expand/collapse a parent item with children
   - `Escape` — Go back (from detail or filter mode); in a child list, return to the parent level at the previous scroll position. When inside a child list the footer shows a `[esc] back` hint (with `(N levels)` when nested deeper than one level).

3. Filter by stage using chord shortcuts:
   - Press `f` then `i` — Filter to idea-stage items
   - Press `f` then `n` — Filter to intake_complete items
   - Press `f` then `p` — Filter to plan_complete items
   - Press `f` then `r` — Filter to in_review items
   - Press `Escape` to cancel an incomplete chord

4. Workflow shortcuts (single-key):
   - Press `c` — Create a new work item
   - Press `i` — Run the implement workflow on the selected item (intake_complete, plan_complete, in_progress)
   - Press `n` — Run the intake workflow on the selected item (idea stage)
   - Press `p` — Run the plan workflow on the selected item (intake_complete stage)
   - Press `s` — Insert a search command

5. Producer review shortcut:
   - Press `r` — Toggle 'Needs Producer Review' flag and add a comment to the selected item

6. Priority update chords (press `u` then `p` then a priority key):
   - Press `u`, `p`, `l` — Set priority to low
   - Press `u`, `p`, `m` — Set priority to medium
   - Press `u`, `p`, `h` — Set priority to high
   - Press `u`, `p`, `c` — Set priority to critical

7. Other update chords (press `u` then a key):
   - Press `u`, `s` — Insert an update stage/status template
   - Press `u`, `t` — Insert an update title template

8. Close/delete chords (press `x` then a key):
   - Press `x`, `c` — Close the selected item
   - Press `x`, `d` — Delete the selected item

9. Audit chords (in_review stage only, press `a` then a key):
   - Press `a`, `a` — Run automatic audit on the selected item
   - Press `a`, `y` — Approve the selected item (mark ready to close)
   - Press `a`, `r` — Reject the selected item (mark not ready to close)

10. Quit:
   - Press `q` to close the worklist pane

### From the command line

```bash
# Direct invocation (opens in a new tab)
herdr plugin action run worklog-selection-list open-worklist
```

### Configuration

The plugin respects the following environment variables:

- `WL_COUNT` — Number of work items to fetch (default: 20, now superseded by `browseItemCount` in settings)

#### Plugin Settings (config file)

Settings are persisted in `~/.config/herdr/worklog-plugin.json`. Key settings include:

- `autoRefresh` — Enable periodic auto-refresh of the work item list (default: `true`)
- `refreshIntervalMs` — Interval in ms between auto-refreshes (default: `30000`). Refresh cycles are single-flight: a tick that fires while the previous refresh is still awaiting its `wl` calls is skipped (no overlapping refresh cycles / wl spawn bursts from a pane), and the cadence resumes on the next tick (WL-0MSBVYBMD004007C).
- `autoSync` — Enable periodic background `wl sync` before auto-refreshes (default: `true`). Background syncs use a single-flight in-process guard and pass `wl sync --if-idle`, so overlapping syncs (from this pane or other panes/TUI instances) are skipped instead of piling up — preventing wl sync lock storms (WL-0MSAB7ZUC004SK7E).
- `syncIntervalMs` — Interval in ms between background `wl sync` calls (default: `60000`, minimum: `60000`; set to `0` to disable auto-sync)
- `browseItemCount` — Max number of non-mandatory items to show in the list (default: `10`, range `1`–`50`; critical and completed/in_review items are always shown regardless)
- `showHelpText` — Show the shortcut hint line at the bottom of the list (default: `true`); changes apply on the next render without a plugin restart
- `showIcons` — Toggle icons in the list (default: `true`)

### Pause-when-hidden (pane visibility gating)

When the worklist pane's tab is **hidden (not focused)**, the auto-refresh and
auto-sync timers pause so hidden panes stop spawning `wl` processes (~4–5 per
30s tick per pane). With many open panes this previously caused heavy `wl`
process churn and memory pressure (WL-0MSB1N0HB0007N6N).

- **Visibility signal** — Herdr sets `HERDR_PANE_ID` for panes it spawns; a
  hidden (non-focused) tab reports `result.pane.focused === false` from
  `herdr pane get <id>`. The plugin checks this via `visibility.ts`.
- **Fail-open** — when visibility cannot be determined (no `HERDR_PANE_ID`
  env, herdr CLI missing/erroring, unparseable output) the pane is treated
  as visible and polling proceeds exactly as before. Standalone runs (outside
  Herdr) are unaffected.
- **Cadence unchanged when visible** — while the pane is focused (or
  fail-open), auto-refresh/auto-sync keep their existing intervals (30s /
  60s defaults).
- **Header indicator** — while the pane is hidden the list header shows
  `[paused — hidden]` so operators can tell gating is active; the indicator
  clears as soon as the list refreshes after the pane becomes visible.
- **Immediate refresh on resume** — while the pane is hidden a lightweight
  resume poll (2s interval, `herdr pane get` only — never `wl`) watches for
  the hidden → visible transition; the moment the tab regains focus the list
  re-fetches immediately (with a "Refreshed" notification) instead of waiting
  for the next 30s tick, then the normal cadence resumes.
- **Never gated** — manual actions (navigation, `S` manual sync, shortcut
  chords, the initial data load) work regardless of pane visibility.
- **Shared visibility check** — the `PollGate` TTL memoizer (~2s) makes the
  refresh and sync ticks in one cycle share a single `herdr pane get` call
  (≤1 visibility exec per cycle).
- **No settings toggle** — pause-when-hidden is always on.

### Selection List Behaviour

The default (unfiltered) worklist always shows **all** critical-priority
items and **all** completed/in_review items (the producer-review queue),
regardless of the `browseItemCount` setting:

- Items with `priority=critical` are always included.
- Items with `status=completed` **and** `stage=in_review` are always included.
- The `browseItemCount` limit applies only to the remaining "other" items.
  The number of "other" slots is `browseItemCount − (critical count) −
  (completed/in_review count)`, floored at zero.
- When critical + completed/in_review items alone meet or exceed
  `browseItemCount`, all of them are shown anyway (no hard cap on the
  mandatory set) — the total may exceed the configured count.
- An item that is both critical and completed/in_review counts once
  (deduplicated) toward the total.

Example: with `browseItemCount=15`, 2 critical + 3 completed/in_review +
20 other items → the list shows 2 critical + 3 completed/in_review + the
first 10 others (15 total). If there were 20 completed/in_review items
instead of 3, all 22 mandatory items would be shown (22 > 15).

The **stage-filtered** views (press `f` + stage chord) are unchanged: they
show only items matching the selected stage.

The "top N of M" header reflects the **actual displayed count** (N), which
may exceed `browseItemCount` when the mandatory set is large.

## Metadata panel

The list view reserves the bottom rows of the pane for a metadata panel
showing the **selected** item's fields. The panel is always on: the list
area shrinks to `rows - 1 - panelHeight`, and `panelHeight` scales linearly
from 20% of the pane height (on short panes) up to 40% (on tall panes),
clamped to a minimum of 3 rows so it is always usable.

- The panel shows the item ID as a header separator, followed by its
  metadata (status, stage, priority, type, risk, effort, children/parent
  counts, tags, GitHub issue number, created/updated timestamps, and audit
  state).
- For items whose stage is `in_progress`, the panel additionally shows
  **`Last command:`** — the most recent command the plugin dispatched
  against that item (`none yet` until the first dispatch).
- The panel scrolls **independently** of the list: press `m` to scroll the
  panel down and `M` to scroll it up. A `[m/M scroll N%]` indicator appears
  on the last panel line whenever the content overflows. Navigating the
  list, filtering, or refreshing resets the panel scroll so the top of the
  panel is always visible again.

## Stage grouping

Work items are grouped by their Worklog **stage** using the standard
lifecycle stages only — `idea`, `intake_complete`, `plan_complete`,
`in_progress`, `in_review`, `done`. No custom stage values are required for
grouping, so podcast episode items group exactly as their frontmatter
`pipeline_stage` maps 1:1 onto the Worklog stages (PRD §7.2). Groups render
in the canonical order (Critical → Group N → Idea → Other → In Review) with
group separators in the list; stage changes re-group items on the next
refresh.

## Markdown viewer

When a work item's description carries a `Key Files:` path to a markdown
document (e.g. a podcast episode `.podcast.md`), the **detail view** renders
that file with a generic markdown viewer instead of showing only the raw
description. The viewer:

- skips the YAML frontmatter block;
- renders ATX headings, bullet lists, fenced code blocks, and paragraphs;
- is preview-only (no notes editor);
- falls back to the raw description when the file is missing/unreadable.

The rendered lines appear under an `Episode file (md viewer)` heading in the
detail view, scrollable with the usual `↑↓/j:k` keys.

## Inline note links

Inline `[NOTE <id>: ...]` review-note markers (PRD §7.1) — where `<id>` is
the Worklog note-child work item id — are rendered as **clickable links** to
the note work items: the marker is displayed as `<id>↗` and the note text is
never shown in the viewer (notes are internal review notes, not dialogue).
This applies to both the description section and the markdown viewer in the
detail view.

## Command log

Every command the plugin dispatches against a work item is recorded in a
local JSON log so the panel (and tools) can show what was last run against
an item. Recording is best-effort: it happens **before** the command is
executed (a downstream failure never skips the entry) and a log failure
never breaks dispatch.

- **What is recorded** — Any command routed through the plugin's dispatch
  paths (`dispatchChordCommand` / `resolveAndRouteCommand`, single-key
  shortcuts, and form submissions) that carries a work item ID, either via
  `<id>` substitution or as an explicit ID token in the command text.
- **What is not recorded** — Commands without an item ID (e.g. plain shell
  commands), commands dispatched directly through the external `wl` CLI
  outside the plugin, and failed `<id>` resolutions (no item selected).
- **Log file** — `~/.config/herdr/worklog-command-log.json`. Per item the
  log keeps the most recent `MAX_ENTRIES_PER_ITEM` (50) entries. The file
  is written atomically (temp file + rename); missing, empty, or corrupt
  JSON degrades gracefully to an empty log.

## Command input form

When a chord shortcut resolves to a command that contains **unknown identifiers** — angle-bracket placeholders other than the known `<id>` (e.g. `--status <status>`, `--stage <stage>`, `--reason <reason>`) — the plugin displays a modal form overlay instead of dispatching the command directly:

- One labeled input field per unknown identifier; `Tab`/`↑`/`↓` navigate between fields, `Enter` submits, `Esc` cancels.
- The active field shows a block cursor at the end of its value; the typed value is substituted into the command on submit (`<id>` remains auto-substituted with the selected item's ID).
- The dialog width is **80% of the pane width** (clamped to a 40-column minimum and to the pane width minus borders), and stays horizontally centered.
- The description and field values **wrap at the dialog's inner width**; as a value wraps to more lines the dialog **expands downward**, bounded by the terminal height so it never overflows the pane.

Rendering is ANSI-aware: visible width is measured by stripping SGR escape sequences (no external width/wrap dependencies).

## Architecture

```
packages/herdr/
├── herdr-plugin.toml       # Herdr plugin manifest
├── README.md               # This file
├── src/
│   ├── index.ts            # Entry point — TUI main loop
│   ├── fetcher.ts          # Worklog data fetching via wl CLI
│   ├── auto-sync.ts       # Background `wl sync` with configurable timer
│   ├── shortcut-config.ts  # Chord shortcut registry and config loader
│   ├── shortcuts.json      # Shortcut/chord definitions
│   ├── icons.ts            # Icon and colour helpers
│   ├── code-freeze.ts      # Code Freeze marker detection (fail-open)
│   ├── form-dialog.ts      # Form state + rendering for parameter input (unknown <identifiers>)
│   ├── md-viewer.ts        # Generic markdown viewer + inline [NOTE <id>: ...] link rendering
│   ├── command-log.ts      # Command log: record/get last command per work item
│   ├── settings.ts         # User settings management
│   └── worklist.ts         # List state, rendering, keyboard handling, command output
├── scripts/
│   ├── open.sh             # Open the worklist pane
│   ├── toggle.sh           # Toggle the worklist pane
│   ├── send-to-pi.sh       # Split pane to right, launch pi with agent command
│   ├── run-in-pane.sh      # Run a shell command visibly in a new pane (stays open for inspection)
│   └── open-pi-agent.sh    # Open a fresh interactive pi agent pane
└── tests/herdr/            # Test files
```

### Design decisions

- **No direct database access** — The plugin uses the `wl` CLI as the backend data source, ensuring compatibility without duplicating data-access logic.
- **Terminal UI via raw mode** — The TUI uses raw stdin mode and ANSI escape codes for rendering, making it compatible with any Herdr pane without additional dependencies.
- **Fixed-height pane rendering** — The list renderer budgets its output to `rows - 1` lines (header + blank + filter bar + items + group separators + fill + footer), reserving the last row for the transient notification line (e.g. `[Synced]`, `[Refresh failed]`). Group separator lines count against the budget, so the pane never scrolls the header or top items off the top of the view regardless of item/group count (see WL-0MSAAON63003N6LO).
- **Testable core** — All state management, formatting, and keyboard handling is pure logic in `worklist.ts`, fully testable without a terminal.
- **Toast notifications instead of bottom-line status** — Transient status feedback (refresh outcomes, sync outcomes, sent/skipped command feedback, errors) is surfaced via Herdr toast notifications (`herdr notification show`) instead of being appended to the bottom of the pane output. This keeps the rendered pane within the terminal height budget, so the list header and top lines are never pushed off the top of the pane. Toast delivery requires `ui.toast.delivery = "herdr"` in `~/.config/herdr/config.toml`; toasts appear in the bottom-right corner by default. The helper lives in `notify.ts` and is fire-and-forget (failures are tolerated silently).
- **Command routing via callback** — When a chord resolves to a non-`/wl` command, it is passed to an `onCommand` callback (set by the entry point) which routes it by prefix:
  - `!!`/`!` prefixed commands (shell-executed shortcuts such as audit approve/reject, priority updates, close/delete) are run **visibly in a new herdr pane** via `scripts/run-in-pane.sh` — the wrapper keeps the pane's process alive so the pane stays open (exit status reported; dismiss with Enter or close with `prefix+x`) so the user can inspect the command output.
  - Everything else is written to stdout with a `CMD:` prefix for the calling framework (Herdr) to execute.
- **Pi agent dispatch** — Agent commands (`/skill:*`, `/intake`, `/plan`) are intercepted by the entry point and routed to a new pi agent pane. The `send-to-pi.sh` script splits the current pane to the right, creates a new pane, runs `pi` with the command as the initial prompt, and renames the pane to "Pi Agent". Agent commands are routed before any prefix handling, so they are unaffected by `!!`/`!` processing.
- **Model selection per shortcut** — Each LLM-bound shortcut entry in `shortcuts.json` may carry an optional `model` field (a pi model pattern such as `plan`, `code`, or `author`). When the command is dispatched to the agent channel, `--model <pattern>` is forwarded to the spawned `pi` CLI (e.g. `pi --model code '/skill:implement <id>'`), so every workflow runs on an appropriately specialised model without manual model switching. Agent-bound entries without a `model` field default to `plan`; shell (`!!`) and `/wl` filter entries never carry a model and never receive a `--model` flag. The default mapping in `src/shortcuts.json`: `/plan`, `/intake`, `/skill:audit` → `plan`; `/skill:implement` → `code`; `/prompt:` → `author`.
- **Free-form prompts via `/prompt:`** — Commands starting with `/prompt:` are also routed to the agent pane, but the `/prompt:` routing prefix is stripped before `send-to-pi.sh` runs, so pi receives only the bare prompt text (e.g. `pi "Review the current work item and suggest next steps"`). This lets a chord shortcut open a new pi instance with an arbitrary injected prompt, not just a skill/workflow invocation. The `o-p` chord provides a default `Review the current work item and suggest next steps` prompt; edit `src/shortcuts.json` to bind your own prompt text to any free chord.
- **Correct project directory for new panes** — Panes created by `send-to-pi.sh`, `open-pi-agent.sh`, and `run-in-pane.sh` are started in the correct project root. Herdr's `follow` CWD policy would otherwise inherit the source pane's CWD (the plugin directory), so each script resolves a target CWD (`--cwd` arg > `HERDR_RESOLVED_CWD` > `$PWD`) and passes it to `herdr pane split --cwd`. The entry point passes the resolved worklog root (`wlRoot`) so skills, `wl` commands, and relative paths operate on the user's project rather than the plugin's installation directory.
- **`<id>` placeholder resolution** — Before output, any `<id>` placeholders in the resolved command are replaced with the currently selected work item's ID. If no item is selected and the command requires `<id>`, the command is silently dropped (graceful no-op).
- **Parameter input form** — Chord commands containing unknown `<identifier>` placeholders open a modal input form (`form-dialog.ts`) before dispatch. The dialog renders at 80% of the pane width (40-column minimum, centered), wraps the description and field values at its inner content width, and expands downward as content wraps — bounded by the terminal height. Every content line is padded to exactly the border width so the box borders stay aligned at any pane width (see WL-0MSAKRBOC005T320).
- **Chord shortcut system** — Multi-key chord sequences are defined in `shortcuts.json` and resolved via `ShortcutRegistry`. Chords can be filtered by view (list/detail) and stage. Entries may carry an optional `model` field (see **Model selection per shortcut** above).
- **Metadata panel** — The bottom of the list view is reserved for the selected item's metadata (`formatMetadataPanel` in `worklist.ts`). The panel height ramps linearly with pane height (20% → 40%, min 3 rows) via `computeMetadataPanelHeight`, and the panel scrolls independently (`m`/`M`) with a scroll indicator. Row building is shared with the detail view via `buildMetaRows`, so the two views never drift apart (see WL-0MSAYNVBY006LM9X).
- **Command log** — Dispatched commands targeting a work item are recorded in `command-log.ts` before execution; the panel surfaces the last command for `in_progress` items. Recording is fire-and-forget (never breaks dispatch) and the log file is written atomically (see WL-0MSAYNVBY006LM9X).

## Code Freeze

While a ship-it (dev → main release) process is running, the project is put into **Code Freeze**: new implementation work must not land on `dev` until the release completes. This plugin detects the freeze and enforces it client-side in the worklist.

### Marker contract (cross-repo)

The freeze state is communicated via a marker file written by the ship release process (owned by the SorraAgents ship skill — see `SA-0MSBU4OBU005WJNB`) and read by this plugin:

```
<worklog-dir>/code-freeze.json
```

Where `<worklog-dir>` is the project's `.worklog/` directory (the same directory the plugin passes to `wl --worklog-dir`). The file is JSON:

```json
{
  "active": true,
  "reason": "ship release in progress",
  "startedAt": "2026-08-02T00:00:00Z",
  "pid": 12345
}
```

Semantics:

| Marker state | Freeze status |
|---|---|
| File present with `active: true` | **ON** — implementation blocked |
| File absent | OFF |
| `active: false` (or missing) | OFF |
| Corrupt / unreadable file | OFF (fail-open) |

Fail-open is deliberate: a broken or missing marker must never block browsing the worklist.

### Plugin behaviour while frozen

- **Banner** — The selection list renders a prominent red `⛔ CODE FREEZE` banner above the header, warning that implementation is blocked. The banner respects the `rows - 1` pane-height budget (see WL-0MSAAON63003N6LO).
- **Implement shortcut hidden** — The `i` / `/skill:implement` shortcut in `shortcuts.json` carries `"code_freeze": "block"`, so while a freeze is active it is filtered out of the shortcut registry: it does not appear in the footer/chord help hints and pressing it does nothing (no dialog, no dispatch). See [Shortcut filtering during a freeze](#shortcut-filtering-during-a-freeze).
- **Implement commands blocked** — Any implement command (`/skill:implement`, `/skill:implement-single`, `/skill:implementall`, via single-key `i`, chord, or typed dispatch) is **not** routed: no pi agent pane is spawned, no work item is claimed, and no `<id>` substitution happens. The marker is re-read at dispatch time, so a freeze that starts between refreshes is still enforced.
- **Notice dialog** — When an implement command is attempted during a freeze, a modal dialog explains that implementation is blocked until the release finishes. Dismiss with `Esc`, `Enter`, or `q` to return to the list.
- **Other commands unaffected** — Audit, intake, plan, review, priority, search, sync, and navigation continue to work normally during a freeze.

### Shortcut filtering during a freeze

Each entry in `shortcuts.json` may carry an optional `code_freeze` field controlling its visibility while the project is frozen (WL-0MSD81VEL009XHWA):

| `code_freeze` value | Behaviour during a freeze |
|---|---|
| `"block"` | Shortcut hidden: excluded from registry lookups and help hints; pressing its key does nothing |
| `"allow"` | Shortcut always shown, even during a freeze |
| omitted | Always shown (backward compatible) |

Any other value is logged as invalid and treated as omitted (always shown) — a bad value never hides or breaks a shortcut. The registry methods `lookupChord()`, `lookupChordEntry()`, `getEntriesForStage()`, `getChordByPrefix()`, `getChordByLeader()`, and `getChordEntries()` accept a `codeFreezeActive` parameter and exclude `"block"` entries while a freeze is active, so footer hints, chord hints, and dispatch lookups all respect the freeze automatically.

This plugin only **reads** the marker; writing/clearing it is the ship release process's job (tracked in `SA-0MSBU4OBU005WJNB`).

## Development

```bash
# Run tests
npx vitest run tests/herdr/

# Run the plugin directly (outside Herdr)
npx tsx packages/herdr/src/index.ts

# Build TypeScript
cd packages/herdr && npx tsc
```

## License

MIT — see [LICENSE](../../LICENSE) for details.
