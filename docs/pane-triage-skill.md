# Pane-Triage Skill and the Pane-Close Bridge

> Documents the approval-gated manual pane cleanup skill
> (`WL-0MUJMXVPO0016DZM`) and the cross-language bridge that exposes the
> shared pane-close classifier to it.

## Background

Two mechanisms decide whether a herdr pane may be closed:

1. **Automatic reaper** (`WL-0MUJW9EEP009Q0V3`) — runs unattended in the
   downtime worker and closes settled panes on a schedule.
2. **Pane-triage skill** (this work) — the manual, workspace-scoped,
   approval-gated complement. A producer reviews idle panes (with work-item
   context and a log tail) and closes a chosen subset.

Both mechanisms must agree on what "idle" means. They do so by sharing one
classifier: `classifySession` / `extractFinalAssistantText` in
`packages/herdr/src/pane-close.ts`. Neither mechanism reimplements the logic.

## The bridge: `packages/herdr/src/pane-close-cli.ts`

The classifier lives in TypeScript; skills are Python. The bridge closes that
gap without duplicating logic:

- `pane-close-cli.ts` wires the production `ReaperDeps`
  (`createHerdrReaperDeps`) and invokes the shared `runReaperCli`.
- `--json` emits a single machine-parseable document for every evaluated
  pane (classification, reason snapshot, work-item id, workspace, tab).
- `--workspace <id>` scopes evaluation to one workspace.
- `--fixture <path>` classifies offline from a raw `herdr pane list` document
  — no herdr or `wl` subprocesses — so the skill's fixture tests exercise the
  shared classifier end-to-end.

Build it with:

```bash
cd packages/herdr && npm run build   # emits dist/pane-close-cli.js
```

The `bin` entry `worklog-pane-close` is registered in `packages/herdr/package.json`.

### JSON shape

```json
{
  "panes": [
    {
      "paneId": "w2V:p7B",
      "paneTitle": "Downtime triggered implement Foo - WL-0ABC123",
      "itemId": "WL-0ABC123",
      "workspaceId": "w2V",
      "tabId": "w2V:t1X",
      "kind": "implement",
      "close": false,
      "reasonCode": "implement",
      "reasonSnapshot": { "needsProducerReview": false, "isInvokingPane": false },
      "success": true
    }
  ],
  "evaluated": 1,
  "closeCount": 0,
  "failureCount": 0,
  "dryRun": true
}
```

## The skill

`skill/pane-triage/` (tracked in ContextHub; deployed to the global skills
directory as `/skill:pane-triage`) contains:

- `SKILL.md` — the agent-facing specification.
- `scripts/pane_triage.py` — core logic: workspace resolution, bridge
  parsing, report rendering, recommendation rules, approval parsing, and
  re-verify-before-close.
- `scripts/pane-triage.py` — CLI wrapper (argv, prompts, log tails, herdr
  close calls).
- `tests/test_pane_triage.py` — offline fixture tests (30 tests).

Idle classification is never reimplemented: `classify_via_bridge()` shells
out to the compiled bridge with `--json --dry-run`.

## Never-close guards (universal)

Applies to **both** the manual skill and the automatic reaper:

- `implement` panes,
- items with `needsProducerReview=true`,
- the invoking pane (`HERDR_PANE_ID`),
- panes with live child processes.

These are enforced in `classifySession` and surface as non-`close` reason
codes; the skill additionally excludes the invoking pane and review-pending
panes from its "Recommended to close" table.

## Approval gate

The skill never closes anything unattended. After rendering the report it
prompts `yes` / `select N,M` / `no`. `no` or ambiguous input closes nothing.
Immediately before each close it re-reads the pane list via the bridge and
drops any pane that is no longer idle (re-verification, AC7).

## Testing

```bash
cd skill/pane-triage && python3 -m pytest tests/ -q     # skill logic
npx vitest run packages/herdr/src/pane-close-*.test.ts   # bridge + classifier
```
