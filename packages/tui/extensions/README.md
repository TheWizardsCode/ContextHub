# Worklog Pi Extension

Extension modules for the Worklog Pi agent integration.

This extension auto-loads into every pi session via the global extension
install (`~/.pi/agent/extensions/worklog` → `packages/tui/extensions`). It
registers the agent-side plugin modules that complement the Herdr plugin
(which provides work item browsing and management):

- [Activity Indicator](#activity-indicator)
- [Session Health Footer](#session-health-footer)
- [Model/Provider Display](#modelprovider-display-line-3)
- [Guardrails](#guardrails)
- [Skill-path Tool](#skill-path-tool)
- [Error Recovery Module](#error-recovery-module) (`/retry`)
- [Lease Release](#lease-release)

> The Pi-based TUI browse UI (chat pane, action palette, `/wl` command,
> `ctrl+shift+b` shortcut, settings overlay, auto-injection, and periodic
> request scheduler) has been removed from the repository — the Herdr plugin
> covers browsing, filtering, detail views, shortcuts, and code-freeze
> awareness. See `packages/herdr/` for that plugin.

## Activity Indicator

The extension displays a **persistent activity indicator** in the Pi footer,
showing the currently executing command or skill. The indicator appears as a
status line with a `⏵` prefix in the theme's accent color, positioned above
the directory path and Git branch info.

### What Triggers the Indicator

| Input Type | Example | Indicator Behavior |
|------------|---------|-------------------|
| Skills | `/skill:audit WL-123` | Shows `⏵ skill:audit` |
| Built-in Pi commands | `/model`, `/settings`, `/new` | Clears the indicator |
| Free-form text | `Fix the login bug` | Clears the indicator |
| Other extension commands | `/other-ext-cmd` | Not detectable (Pi limitation) |

### Persistence

- The indicator persists across turns within a session until new input is typed.
- Creating a new session (`/new`) clears the indicator.
- Resuming a session (`/resume`) attempts to recover the last-known command
  from the session's history (best-effort).

### Graceful Degradation

The indicator gracefully degrades in non-TUI modes (print, JSON, RPC) where
`setStatus` is a no-op. The feature has no effect and does not produce errors
when used outside the Pi TUI.

### Technical Notes

- Uses Pi's `ctx.ui.setStatus()` API with the key `worklog-activity` to
  display the indicator in the footer's status line area. This avoids
  replacing the entire footer and does not conflict with existing widget
  or status usage.
- The indicator text is truncated to fit the terminal width with an ellipsis
  (`…`) for overflow.
- Skills (`/skill:name`) are captured via Pi's `input` event, which fires
  before skill expansion.
- Built-in Pi commands and free-form text clear the indicator via the same
  `input` event handler.

## Session Health Footer

The extension displays a **real-time session health footer** that replaces
Pi's default footer with a rich health dashboard showing:

### What It Displays

The footer uses a **three-section layout**: **left** (status + elapsed time since last response + turn count + last-chunk timer), **center** (total wall-clock session duration), and **right** (token usage + context + model).

| Element | Description |
|---------|-------------|
| **Status marker** | `○` idle, `●` streaming, `⚡ <tool>` tool execution |
| **Last chunk time** | Elapsed time since the last streaming chunk (e.g., `(Last Chunk: 3s ago)`) — shown only during active streaming |
| **Turn count** | Number of turns in the current session (e.g., `#3`) |
| **Response elapsed** | Colour-coded elapsed time since the last model response (shown after the state marker in the left section) |
| **Total session time** | Total wall-clock session duration (e.g., `Total: 5m 42s`) — shown in the center section |
| **Token usage** | Input/output token counts (e.g., `↑1.2k ↓4.5k`) |
| **Context usage** | Percentage of context window (e.g., `76.8%/128k`) |
| **Model ID** | Currently active model (e.g., `gpt-4`). While a model alias is selected but no resolved provider/model has been received yet, shows `{alias} → (resolving)` (e.g., `code → (resolving)`). |

### Colour Coding

The response age indicator uses colour coding to provide at-a-glance health:

| Colour | Threshold | Meaning |
|--------|-----------|--------|
| Green (`success`) | < 5s | Healthy — response received recently |
| Yellow/Orange (`warning`) | 5–30s | Moderate delay — model is processing |
| Red (`error`) | > 30s | Stuck or slow — consider interrupting |

### Layout

The footer spans three lines. The first line shows extension status entries
(e.g., activity indicator). The second line shows session health metrics in
a **three-section layout**. The third line shows the model/provider info and
(optionally) an initial prompt preview:

```
⏵ /skill:audit WL-123                                                       ← Extension statuses
● Streaming 45s #5   Total: 5m 42s  ↑1.2k ↓4.5k 39.1%/128k                  ← Session health
code → openai/gpt-4  │  Fix the bug                                          ← Model + prompt
│  │          │   │  │             │           │    │       │              │
│  │          │   │  │             │           │    │       └────────────── Context usage
│  │          │   │  │             │           │    └────────────────────── Output tokens
│  │          │   │  │             │           └─────────────────────────── Input tokens
│  │          │   │  │             └─────────────────────────────────────── Total session time
│  │          │   │  └───────────────────────────────────────────────────── Last chunk timer (streaming only)
│  │          │   └──────────────────────────────────────────────────────── Turn count
│  │          └──────────────────────────────────────────────────────────── Elapsed time since last response
└────────────────────────────────────────────────────────────────────────── Status marker
```

### Model/Provider Display (Line 3)

The third footer line shows the model alias and resolved provider/model in
dimmed text. The display varies depending on available state:

| State | Example |
|-------|---------|
| Model alias selected, resolved provider/model received | `code → openai/gpt-4` |
| Model alias selected, waiting for resolution | `code → (resolving)` |
| No model alias, resolved provider/model available | `openai/gpt-4` |
| No model info at all | `—` |

When an initial prompt preview is available, it is shown after the model
info separated by a vertical bar (e.g., `code → openai/gpt-4  │  Fix the bug`).

During **idle** or **tool execution**, the last-chunk timer is not shown.

### Event Tracking

The extension subscribes to the following Pi lifecycle events to update state:

| Event | Update |
|-------|--------|
| `turn_start` | Increment turn count, set status to streaming, set last-response timer |
| `message_update` | Update last-chunk timer (shown during active streaming) |
| `message_end` (assistant) | Set status to idle, update response time |
| `tool_execution_start` | Set status to tool with tool name |
| `tool_execution_end` | Reset status to idle |
| `model_select` | Refresh footer display |
| `session_start` | Reset counters, initialize footer |
| `session_shutdown` | Clean up ticker interval |

### Ticker

A 1-second `setInterval` ticker refreshes the token counts and context usage
from the session manager. The footer re-renders automatically when the branch
changes.

### Graceful Degradation

The session health footer gracefully degrades in non-TUI modes (print, JSON,
RPC) where `setFooter` is a no-op. The feature has no effect and does not
produce errors when used outside the Pi TUI.

### Technical Notes

- Uses Pi's `ctx.ui.setFooter()` API to replace the entire footer with a
  custom render function.
- The footer renderer uses `truncateToWidth` and `visibleWidth` from
  `@earendil-works/pi-tui` for safe ANSI-aware truncation.
- Only one `setFooter()` can be active at a time. This module's footer
  replaces Pi's default footer (git branch, cwd path, etc.).
- The footer includes extension status entries (set via `ctx.ui.setStatus()`)
  from `footerData.getExtensionStatuses()` as the first line. This ensures
  that status entries from other modules — such as the resolved
  provider/model (`worklog-0model`) and the activity indicator
  (`worklog-activity`) — remain visible alongside the session health metrics.
- The footer uses a **three-section layout**: left (status marker + elapsed
  time since last response + turn count + last-chunk timer), center (total
  session duration), and right (token counts + context usage + model ID).
- A `lastChunkTime` property tracks the timestamp of the last `message_update`
  event. The **last-chunk timer** `(Last Chunk: Xs ago)` is displayed in the
  left section only when `status === 'streaming'`.
- Token counts are calculated from session entries by summing
  `usage.input` and `usage.output` from assistant messages.
- Context usage is obtained from `ctx.getContextUsage()` which returns
  `{ tokens, contextWindow, percent }`.

## Guardrails

The extension installs **guardrails** that protect worklog data by blocking
direct file writes/edits to protected worklog paths (`.worklog/` database and
JSONL files) and blocking dangerous shell commands that could damage worklog
data. Agents are directed to use `wl` commands instead. See
`docs/guardrails.md` for details.

Implemented in `Worklog/lib/guardrails.ts` and registered via
`INSTALL_GUARDRAILS(pi, { enabled: true })`.

## Skill-path Tool

The extension registers a `skill_path` tool via `pi.registerTool()` that
resolves a skill's installation directory given a skill name (searches
`~/.pi/agent/skills/<name>/` and the project's `.pi/skills/<name>/`).
Agents use it to locate skill files (e.g., `SKILL.md`) during tasks.

Implemented in `Worklog/lib/skill-path.ts`.

## Error Recovery Module

The extension includes a built-in automatic error recovery module that replaces the
standalone `pi-retry` extension. When the recovery module is active, pi's built-in
retry mechanism is suppressed and errors are handled according to per-category
configuration.

### Error Categories

| Category | Default Action | Description |
|----------|---------------|-------------|
| `rateLimit` (429) | NOT retried | Informative error shown to the user |
| `serverError` (5xx) | Retried | Exponential backoff with configurable delay |
| `authError` (401/403) | NOT retried | Checkpoint saved + terminal error displayed |
| `contextLength` | Compact + Continue | `/compact` triggered, then auto-continue |
| `quotaExhausted` | NOT retried | Checkpoint saved + terminal error displayed |
| `timeout` | Retried | Exponential backoff with configurable delay |
| `terminated` | NOT retried | Checkpoint saved + terminal error displayed |
| `parseError` (JSON) | Single-shot continue | One plain "continue" prompt, no backoff loop |

### Configuration

Recovery behaviour is driven by `DEFAULT_RECOVERY_CONFIG` in
`Worklog/lib/recovery/error-patterns.ts`. Each category can be configured:

```json
{
  "serverError": {
    "enabled": true,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000
  },
  "timeout": {
    "enabled": true,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000
  },
  "rateLimit": {
    "enabled": false
  }
}
```

### `/retry` Command

The module registers a `/retry` command with the following subcommands:

- `/retry` — Manual trigger: auto-detects the last error and applies the correct
  recovery strategy (retry, compact+continue, single-shot continue, or warning)
- `/retry status` — Displays diagnostics: per-category attempt counts, last
  error messages, is-retrying flags, continuation count
- `/retry reset` — Resets all retry counters and state

### Mid-Session Compaction Auto-Continue

When Pi performs a **mid-session** compaction (threshold auto-compaction while the
agent still has work in flight), the module automatically resumes the agent via
the invisible-continue loop (`agent.prompt([])`) — no manual "continue" needed.

- **Auto-continues when**: queued messages are pending (`ctx.hasPendingMessages()`),
  the last assistant turn was interrupted (`stopReason` `length`/`error`), or the
  agent was still running when compaction started.
- **Does not auto-continue when**: the compaction is overflow recovery
  (`willRetry: true` — Pi retries the aborted turn natively, continuing again
  would double-continue) or an end-of-session compaction (agent settled, nothing
  pending — e.g. manual `/compact` after a completed turn). Manual `/compact`
  auto-continues only when demonstrably mid-session (pending work).
- **Safety guards**: user abort (ESC), session switches, the retry-loop mutex, and
  the continuation-in-flight flag are all respected — no continuation starts when
  the user has aborted, the session changed, or another continuation/retry is
  already running.

The classification lives in `shouldAutoContinueAfterCompaction()` in
`recovery.ts`; the `session_compact` handler is wired in `register-recovery.ts`.

### Architecture

The recovery module is implemented in `Worklog/lib/recovery/` and consists of:

| File | Purpose |
|------|---------|
| `error-patterns.ts` | Error classification patterns for all 8 categories |
| `retry-logic.ts` | Exponential backoff, state managers, interruptible sleep |
| `recovery.ts` | Compact-and-continue, checkpoint-and-terminate, and single-shot parse-error continue handlers |
| `retry-command.ts` | `/retry` command interface (status, reset, manual-trigger) |
| `register-recovery.ts` | Extension lifecycle wiring (agent_end, turn_end, session_start, session_compact) |

The module is auto-registered during extension initialization in `index.ts`.

## Lease Release

The extension includes a **proactive lease release** module that automatically
releases the previous session's model lease when a new Pi session is created
(via `/new`). This speeds up model reclamation on the Local Proxy provider.

The release logic lives in the **shared module** `@worklog/shared/lease-release`
(`packages/shared/src/lease-release.ts`) so the Pi extension and the Herdr
plugin's pane-close release executor share a single implementation and never
drift (WL-0MSGI7UIH008USVB).

### How It Works

1. When Pi fires a `session_start` event with reason `"new"` (indicating a
   session replacement), the module reads `~/.pi/agent/models.json` to locate
   the `"Local Proxy"` provider's `baseUrl`.
2. It sends a best-effort `POST {baseUrl}/leases/release` with a JSON body
   containing the previous session's identifier (`previousSessionFile`).
3. The call is **fire-and-forget**: it does not block session startup.
   Failures (network errors, non-2xx responses) are silently logged at
   debug level only — no user-visible errors.
4. If the `"Local Proxy"` provider is not configured, no request is sent.

### When It Fires

| Session Start Reason | Lease Release Triggered |
|----------------------|------------------------|
| `"startup"` (initial Pi launch) | No |
| `"new"` (session via `/new`) | Yes |
| `"resume"` (session resumed) | No |
| `"fork"` (session forked) | No |
| `"reload"` (extensions reloaded) | No |

### Technical Notes

- The release logic is implemented in the shared module
  `packages/shared/src/lease-release.ts` and re-exported by
  `Worklog/lease-release.ts`.
- The proxy configuration is read at runtime from `~/.pi/agent/models.json`
  and cached at module level (a single filesystem read per process).
- Registered in `Worklog/index.ts` via `registerLeaseRelease(pi)`.
- Tests are in `Worklog/lease-release.test.ts` (extension wiring) and
  `packages/shared/src/lease-release.test.ts` (shared HTTP behavior).
- The Herdr plugin runs the same release on pi-pane close — see
  `packages/herdr/README.md` ("Pi agent dispatch").
