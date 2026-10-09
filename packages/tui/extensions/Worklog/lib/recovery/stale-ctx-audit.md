# Stale ExtensionContext Audit — Worklog Recovery Module

**Work item:** WL-0MUL1BG09005VRBO
**Scope:** `packages/tui/extensions/Worklog/lib/` (excluding `node_modules`)
**Reference:** WL-0MUIV50EJ007VH9B (stale-ctx `_notifyFn` crash fix)

---

## Classification Criteria

- **Safe:** ctx is used only synchronously within the event-handler scope; no
  async boundary (await, timer, setInterval) retains ctx beyond the handler
  return.
- **At risk:** ctx is captured in a module-level variable, a closure, or an
  async function and may be invoked from a timer/async callback after the
  session has been replaced/reloaded.

---

## Module-by-Module Audit

### 1. register-recovery.ts — _notifyFn path

**Classification: SAFE (hardened by WL-0MUIV50EJ007VH9B)**

- `_notifyFn` is captured from ctx in `agent_end`, `turn_end`, and
  `session_compact` handlers.
- `_notifyFn` is **cleared** (`_notifyFn = null`) on `session_start`.
- All call sites (`_notifyRetryAttempt`, `triggerCompactionContinue`,
  `triggerCompactionGateRecovery`) go through `_safeNotify()`, which wraps
  the dispatch in `try/catch`.
- **Verdict:** No remaining risk on this path.

### 2. recovery.ts

**Classification: SAFE**

- Pure logic module. No ctx captures, no module-level mutable state that
  references ctx.
- Functions are invoked with ctx passed as parameters or via callback
  options objects.

### 3. retry-logic.ts

**Classification: SAFE**

- Pure logic module. `RetryState` and `ContinuationState` are data classes
  with no ctx references.
- `createRetryHintCapturingFetch()` captures `onHint` (a callback, not ctx).

### 4. retry-command.ts

**Classification: SAFE**

- `retryStates`, `continuationState`, `interruptibleState` are plain data
  objects — no ctx.
- `RetryCommandContext` is a parameter interface; all `ctx.ui.notify()`
  calls are synchronous within the command handler.

### 5. error-patterns.ts

**Classification: SAFE**

- Pure logic module — regex patterns, classifiers, and config data. No ctx.

### 6. guardrails.ts

**Classification: SAFE**

- Event handlers receive ctx but use it only synchronously (path/command
  checks, return `block` objects). No async retention.

### 7. skill-path.ts

**Classification: SAFE**

- `_ctx` parameter is declared but never used. File-system operations use
  Node.js APIs, not ctx.

### 8. model-display.ts

**Classification: SAFE**

- `_resolvedModel`, `_selectedModel`, `_onModelChange` are plain data — no
  ctx.
- `session_start` handler uses ctx synchronously only (reads `ctx.model.id`,
  sets module variables).

### 9. activity-indicator.ts

**Classification: AT RISK (one path identified)**

#### Path: `showActivityWithTitleLookup(ctx, text, showIndicator)` (line ~229)

- This async function calls `showActivity(ctx, text, showIndicator)` **synchronously** first (safe).
- Then `await resolveWorkItemTitle(id)` — async boundary.
- After the await, `showActivity(ctx, display, showIndicator)` is called again
  with the **same ctx** that was captured at function entry.
- If a session replacement occurs during the `resolveWorkItemTitle` await,
  the post-await `showActivity()` call would throw.

**Hardening:** Wrap the post-await `showActivity()` call in a try/catch.

**Verdict:** **Hardened in this work item** (AC2 — hardened with guarded pattern).

### 10. session-health.ts

**Classification: PARTIALLY AT RISK (two paths identified)**

#### Path A: `startTicker(ctx)` — `refreshState()` closure (line ~491)

- `startTicker(ctx)` captures `ctx` in the `refreshState()` function.
- `refreshState()` runs via `setInterval(refreshState, TICK_INTERVAL_MS)`
  every second.
- The body of `refreshState()` is already wrapped in a `try/catch` block
  (line ~500), so a stale ctx would be caught and the tick would be skipped.
- **Verdict: SAFE (already guarded).** The try/catch around the entire
  `refreshState()` body provides the same defensive pattern.

#### Path B: `setFooter(ctx)` — `render()` callback (line ~550)

- `setFooter(ctx)` calls `ctx.ui.setFooter()` which registers a `render()`
  callback invoked by the TUI framework.
- The `render()` closure captures `ctx` and uses it: `ctx.mode`,
  `ctx.ui.theme`, `ctx.ui.setFooter`, and passes `ctx` to `renderFooter()`.
- The `render()` callback may fire after a session replacement/reload,
  causing `ctx.ui.setFooter`, `ctx.ui.theme`, or `renderFooter()` calls
  to throw.
- However, the footer render callback is managed by the TUI's own
  lifecycle — Pi's TUI will call the `dispose()` handler on session
  shutdown/start, which clears the ticker interval. The render callback
  itself is expected to be torn down by the TUI.
- **Verdict: AT RISK — but low practical risk.** The TUI lifecycle should
  tear down the footer on session replacement. However, a defensive guard
  is warranted.

**Hardening:** Wrap the `render()` body in a try/catch.

**Verdict:** **Hardened in this work item** (AC2 — hardened with guarded pattern).

---

## Summary

| Module | Classification | Action |
|--------|---------------|--------|
| register-recovery.ts | Safe | Already hardened (parent WI) |
| recovery.ts | Safe | No changes needed |
| retry-logic.ts | Safe | No changes needed |
| retry-command.ts | Safe | No changes needed |
| error-patterns.ts | Safe | No changes needed |
| guardrails.ts | Safe | No changes needed |
| skill-path.ts | Safe | No changes needed |
| model-display.ts | Safe | No changes needed |
| activity-indicator.ts | **At risk** | Hardened (try/catch on post-await ctx use) |
| session-health.ts | **Partially at risk** | Hardened (try/catch on setFooter render) |

**Total at-risk paths:** 2
**Paths hardened:** 2 (both in this work item)
**Paths recorded as blocking work items:** 0
