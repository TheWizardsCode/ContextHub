# Compaction Gate: client-side response to the llm-proxy cheap-mode hard cap

**Work item:** WL-0MTBOXEGR009KDP6
**Proxy counterpart:** LP-0MTBOX45O005LD1S (cheap-mode hard local-routing cap — emits the gate signal)

## Overview

The llm-proxy's cheap-mode hard local-routing cap rejects requests whose
context exceeds 1.0×cap with an informative **compaction gate** response
(an HTTP 4xx). The client (this Worklog pi extension's recovery module)
detects the signal, compacts the session via the existing `/compact`
machinery, and automatically retries the original request — never silently
dropping, never queue-falling back to expensive remote, never burning a
near-full-slot prefill.

## Wire contract

The exact status-code/header/body shape is coordinated with the parallel
llm-proxy item **LP-0MTBOX45O005LD1S**. The contract implemented here
(suggested shape, TBD with the proxy author):

```
HTTP/1.1 413 Payload Too Large
X-Compaction-Gate: true

{ "error": "compaction gate: context exceeds cheap-mode cap", "cap": <tokens>, ... }
```

The gate is a **proxy-level signal** and is deliberately **distinct** from
the model-level `stopReason === "length"` context-length event. The two are
never conflated (see Detection below).

## Detection

`classifyError()` in `error-patterns.ts` runs a new `COMPACTION_GATE`
classification **before** the context-length check, matching proxy-specific
signals only:

| Pattern | Matches |
|---|---|
| `compaction gate` | wire-contract keyword |
| `x-compaction-gate` | wire-contract header name echoed in the body |
| `\b413\b` | wire-contract status code |
| `payload too large` | 413 reason phrase |
| `request too large` | common 413 phrasing |
| `cheap mode … cap/limit` | cheap-mode proxy hard-cap signal |

Generic model context-length phrasings (e.g. "maximum context length",
"token limit reached") do **not** match the gate patterns, so
`stopReason: "length"` messages classify as `CONTEXT_LENGTH`, never as the
gate.

## Client behavior

On `agent_end`, when the last assistant message classifies as
`COMPACTION_GATE`, `register-recovery.ts` runs
`triggerCompactionGateRecovery(ctx)`:

1. **Guard** — reuse the recovery module's safety guards plus a
   gate-specific retry-limit guard (`shouldTriggerCompactionGateRecovery`):
   - user abort (ESC) → skip
   - retry-loop mutex (`_continueInProgress`) → skip
   - continuation already in flight → skip
   - continuation count ≥ `MAX_COMPACTION_GATE_RETRIES` (default **2**) →
     fall back to explicit guidance (no infinite detect→compact→retry loop)
2. **Compact** — run `/compact` via the existing
   `executeCompactAndContinue()` machinery (reused from
   WL-0MR269PDV00970YP), wrapping `ctx.compact()`'s fire-and-forget API in
   a promise (`onComplete`/`onError`).
3. **Auto-retry** — on success, fire `triggerInvisibleContinue()`, the
   existing invisible-continue loop (`agent.prompt([])`) reused from
   WL-0MSMGGPWR000MZ0O. The original request is retried without user
   interaction and the outcome is surfaced via notify.
4. **Fallback (never silently drop)** — on compact failure or retry-limit
   reached, show explicit guidance:
   > "Context cannot be compacted further — please start a new session to continue."

   (`COMPACTION_GATE_FALLBACK_MESSAGE`)

The `/retry` command routes a manual retry of a gated message through the
same compact-and-continue machinery.

## Retry-limit guard

`MAX_COMPACTION_GATE_RETRIES = 2`: at most two gate→compact→retry cycles.
If a session is still over the cap after two compactions, it is declared
non-compactable and the fallback guidance is shown. Shared state used:
`ContinuationState` (the count survives across `agent_end` events and
resets on a successful non-error turn — `state.complete()` / `state.reset()`).

## Files touched

- `packages/tui/extensions/Worklog/lib/recovery/error-patterns.ts` —
  `COMPACTION_GATE` category, detection patterns, config, classifier order
- `packages/tui/extensions/Worklog/lib/recovery/recovery.ts` —
  `isCompactionGateResponse()`, `shouldTriggerCompactionGateRecovery()`,
  `MAX_COMPACTION_GATE_RETRIES`, `COMPACTION_GATE_FALLBACK_MESSAGE`,
  `maxRetries` support in `executeCompactAndContinue()`
- `packages/tui/extensions/Worklog/lib/recovery/register-recovery.ts` —
  `agent_end` COMPACTION_GATE dispatch → `triggerCompactionGateRecovery()`
- `packages/tui/extensions/Worklog/lib/recovery/retry-command.ts` —
  manual `/retry` handling for a gated message
- `packages/tui/extensions/Worklog/lib/recovery/compaction-gate.test.ts` —
  detect → compact → retry; failure → fallback; retry-limit guard

## Open items

- Final wire-contract shape (status code, header name, body schema) to be
  pinned with LP-0MTBOX45O005LD1S. Detection is keyword/status based and
  configurable via `DEFAULT_RECOVERY_CONFIG.compactionGate.patterns`, so
  pinning the contract later requires no rework.