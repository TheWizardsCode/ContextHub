# AGENTS.md Install Model

How `wl init` installs agent guidance into a project, how that local guidance
relates to the global agent file, and where duplication/conflict risk remains.

> **Status:** documents the current behavior (verified against
> `src/commands/init.ts` and `tests/cli/init.test.ts`).
> A recommendation to change this model is tracked in
> WL-0MSKEJK4G008BMS0 and the implementation vehicle is
> WL-0MSIXMKOX0052514 (open).

## Overview

Running `wl init` in a fresh project performs two agent-guidance installs:

1. **`templates/AGENTS.md` → `<projectRoot>/AGENTS.md`** — the project-local
   agent instruction file (258 lines of work-item tracking rules, CRITICAL
   RULES, a CLI cheat-sheet, and architecture notes).
2. **Workflow guidance → inlined into `AGENTS.md`** — the optional workflow
   template (`templates/WORKFLOW.md`) is *inlined* between
   `<!-- WORKFLOW: start -->` / `<!-- WORKFLOW: end -->` markers inside the
   project `AGENTS.md`; a standalone `WORKFLOW.md` file is **never** written
   to the repository.

Both installs are prefixed with a **pointer line** that defers to the global
`~/.pi/agent/AGENTS.md` file when one is present:

```
Follow the global AGENTS.md in addition to the rules below. The local rules below take priority in the event of a conflict.
```

## Install flow

```
wl init
  ├─ locateAgentTemplate()
  │    templates/AGENTS.md (packaged) → fallback <projectRoot>/templates/AGENTS.md
  │
  ├─ ensureAgentTemplateInstalled()
  │    │
  │    ├─ AGENTS.md does NOT exist ──► write "{pointer}\n\n{template}"   (always installs)
  │    │
  │    └─ AGENTS.md EXISTS
  │         │
  │         ├─ pointer present ──────► no-op ("pointer already present")  ← idempotent
  │         │
  │         └─ pointer absent
  │              ├─ action=overwrite ► replace with "{pointer}\n\n{template}"
  │              ├─ action=append ───► prepend "{pointer}\n\n{existing}"
  │              ├─ action=skip ─────► no-op ("user chose to manage manually")
  │              └─ no action ───────► interactive O/A/M prompt → same actions
  │
  └─ ensureWorkflowTemplateInstalled()
       └─ --workflow-inline yes (or prompt answer)
            └─ insertWorkflowLoaderIntoAgents(AGENTS.md)
                 │  repo WORKFLOW.md preferred, else packaged template
                 └─ insert "<!-- WORKFLOW: start -->…<!-- WORKFLOW: end -->"
                    if not already present                              ← idempotent
```

### Pointer line

The pointer line is the constant `WORKLOG_AGENT_POINTER_LINE` in
`src/commands/init.ts`:

```ts
const WORKLOG_AGENT_POINTER_LINE =
  'Follow the global AGENTS.md in addition to the rules below. The local rules below take priority in the event of a conflict.';
```

It is always written as the first non-empty line of the installed `AGENTS.md`.
Its semantics:

- **Defer to the global file** — when `~/.pi/agent/AGENTS.md` exists (the
  SorraAgents global install), agents should read it for core workflow
  instructions.
- **Local priority on conflict** — project-local rules take precedence over
  global ones when they disagree.

The pointer is also the idempotence key: `analyzeAgentContent()` detects it as
`firstNonEmpty === WORKLOG_AGENT_POINTER_LINE`, and `ensureAgentTemplateInstalled()`
returns `skipped: true, reason: 'pointer already present'` without touching the
file — re-running `wl init` never duplicates the pointer or template.

### O/A/M prompt

When `AGENTS.md` exists without the pointer and no `--agents-template` flag is
given, `promptAgentTemplateAction()` asks:

| Choice | Meaning | Effect |
|--------|---------|--------|
| **O** – Overwrite | Replace the existing AGENTS.md entirely | Destructive; no chance of conflict with existing content |
| **A** – Add pointer | Prepend the pointer line, keep existing content | Non-destructive; retains existing instructions |
| **M** – Manual | Skip; user manages AGENTS.md themselves | No-op; Worklog agent guidance is not installed |

### CLI flags

| Flag | Values | Behavior |
|------|--------|----------|
| `--agents-template` | `overwrite` (or `o`), `append` (or `a`), `skip` (or `m`/`manual`/`manage`) | Non-interactive action when AGENTS.md exists without the pointer |
| `--workflow-inline` | `yes`/`true`/`1`, `no`/`false`/`0` | Inline workflow template into AGENTS.md (`yes`) or not (`no`); omitted → interactive prompt |

`--agents-template skip` is the common choice for unattended init
(see [WL-0MKVRI3580RXZ54H], the `--agents-template` flag item).

### Idempotence

| Scenario | Result |
|----------|--------|
| No `AGENTS.md` | Installs `{pointer}\n\n{template}` |
| `AGENTS.md` with pointer | No-op — pointer already present |
| `AGENTS.md` without pointer, `--agents-template skip` | No-op |
| `AGENTS.md` without pointer, `--agents-template overwrite` | Replaces file |
| `AGENTS.md` without pointer, `--agents-template append` | Prepends pointer, keeps content |
| `--workflow-inline yes` on re-run | No-op — markers already present |

### WORKFLOW.md: inlining only

`ensureWorkflowTemplateInstalled()` never writes a standalone `WORKFLOW.md`
into the project. Instead it **inlines** the workflow content (repo
`WORKFLOW.md` preferred, else packaged template) into `AGENTS.md` between
`<!-- WORKFLOW: start -->` and `<!-- WORKFLOW: end -->` markers, at the top of
the file. Insertion is skipped when the markers are already present.

## Local vs global relationship

Two sources of agent guidance exist:

| | Local (`templates/AGENTS.md`) | Global (`AGENTS_GLOBAL.md`) |
|---|---|---|
| **Install target** | `<projectRoot>/AGENTS.md` via `wl init` | `~/.pi/agent/AGENTS.md` via SorraAgents `scripts/install_pi.sh` |
| **Install mechanism** | Copied (with pointer prefix) | Symlinked |
| **Scope** | One project | All projects on the machine |
| **Content** | 258 lines: CRITICAL RULES, work-item types/priorities, CLI cheat-sheet, architecture notes | Full agent workflow: work-item lifecycle, workflow steps, push policy, types/priorities |
| **Drift risk** | High — duplicated content must be edited twice | Low — single source |

### Precedence

The pointer line (installed by `wl init`) makes the relationship explicit:

> *"Follow the global AGENTS.md **in addition to** the rules below. The local
> rules below take priority **in the event of a conflict**."*

So precedence is: **local project rules > global file**, with both being read.

### Duplication and conflict risk

The two files overlap substantially — both carry CRITICAL RULES, work-item
Types, priorities, and workflow guidance. That duplication is a real drift
risk: a change (e.g. adding an issue type) must be applied to both files.
Confirmed example: the recent `docs` issue-type addition had to be applied to
`templates/AGENTS.md` **and** `AGENTS_GLOBAL.md` (both carry
`--issue-type: … docs …` today).

## Interaction with the global install

- `wl init` does **not** detect whether `~/.pi/agent/AGENTS.md` exists, and
  does **not** delegate to it. It unconditionally installs its own template
  content (258 lines), prefixed with the pointer line.
- The pointer line is the *only* acknowledgement of the global file: it tells
  agents to also read the global file, but the local template content is still
  installed in full.
- There is **no delegation today** — no code path that says "if the global
  file exists, skip the template and just write a reference."

### Environments

| Environment | What agents see |
|-------------|-----------------|
| **Standalone** (no SorraAgents global install) | Only the project `AGENTS.md` (pointer line points at a file that does not exist — harmless, but no global workflow is loaded) |
| **Global** (SorraAgents `install_pi.sh` run) | Both the global `~/.pi/agent/AGENTS.md` (symlinked from `AGENTS_GLOBAL.md`) and the project `AGENTS.md`, with local rules taking precedence |

## Drift history

- **`docs` issue-type change** — applied to both `templates/AGENTS.md` and
  `AGENTS_GLOBAL.md` (drift risk confirmed in practice).
- **SorraAgents dedup items** (SA-0MSITKHPW002XG4G, SA-0MSIUUYRD002GC8W,
  SA-0MSITKOXI007XD4N — completed): SorraAgents adopted a
  "reference global instead of duplicating" model. Its own project
  `AGENTS.md` now starts with a short pointer to the global file instead of
  duplicating the full content. ContextHub's template has **not** followed.

## Recommendation pointer

The full install-model recommendation is the deliverable of the parent item
WL-0MSKEJK4G008BMS0; implementation is tracked separately in
WL-0MSIXMKOX0052514 ("Align wl init with SorraAgents install: delegate
agent-guidance/workflow setup instead of duplicating"). This document only
describes the current model.

## Related

- `src/commands/init.ts` — `ensureAgentTemplateInstalled`,
  `promptAgentTemplateAction`, `ensureWorkflowTemplateInstalled`,
  `WORKLOG_AGENT_POINTER_LINE`, `WORKLOG_AGENT_TEMPLATE_RELATIVE_PATH`
- `templates/AGENTS.md`, `templates/WORKFLOW.md` — the installed templates
- `tests/cli/init.test.ts` — behavior tests (pointer insertion, idempotence,
  `--agents-template`, `--workflow-inline`)
- [docs/tutorials/01-your-first-work-item.md](tutorials/01-your-first-work-item.md) —
  the init walkthrough that mentions the AGENTS.md prompt
