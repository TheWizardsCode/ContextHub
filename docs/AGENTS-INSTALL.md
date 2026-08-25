# AGENTS.md Install Model

How `wl init` installs agent guidance into a project, how that local guidance
relates to the global agent file, and why the model avoids duplication.

> **Status:** documents the current behavior (verified against
> `src/commands/init.ts` and `tests/cli/init.test.ts`).
> The prior duplicated model (full template copy + pointer line) was retired
> by SA-0MSITKWBP007VUJS; coordination with the Worklog side is tracked in
> WL-0MSIXMKOX0052514 (open).

## Overview

Running `wl init` in a fresh project performs two agent-guidance installs:

1. **`templates/AGENTS.md` → `<projectRoot>/AGENTS.md`** — the project-local
   agent instruction file. The template now contains **only** the canonical
   global-reference structure (a `## Global agent guidance` section pointing at
   `~/.pi/agent/AGENTS.md` plus a `## Project-specific guidance` placeholder) —
   it no longer duplicates the global instruction set.
2. **Workflow guidance → inlined into `AGENTS.md`** — the optional workflow
   template (`templates/WORKFLOW.md`) is *inlined* between
   `<!-- WORKFLOW: start -->` / `<!-- WORKFLOW: end -->` markers inside the
   project `AGENTS.md`; a standalone `WORKFLOW.md` file is **never** written
   to the repository.

There is no separate pointer line anymore: the template **self-references** the
global file via its `## Global agent guidance` section.

## Install flow

```
wl init
  ├─ locateAgentTemplate()
  │    templates/AGENTS.md (packaged) → fallback <projectRoot>/templates/AGENTS.md
  │
  ├─ ensureAgentTemplateInstalled()
  │    │
  │    ├─ AGENTS.md does NOT exist ──► write template                        (always installs)
  │    │
  │    └─ AGENTS.md EXISTS
  │         │
  │         ├─ global reference present ──► no-op ("global reference already present")  ← idempotent
  │         │
  │         └─ global reference absent
  │              ├─ action=overwrite ► replace with template
  │              ├─ action=append ───► prepend template above existing content
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

### Global-reference detection

The canonical template emits the `## Global agent guidance` heading and a
reference line pointing at `~/.pi/agent/AGENTS.md`. `analyzeAgentContent()`
detects either of those (or the legacy pointer line, for backward
compatibility with projects installed before SA-0MSITKWBP007VUJS) to decide
idempotence:

```ts
const CANONICAL_GLOBAL_REFERENCE_MARKER = '## Global agent guidance';
const CANONICAL_GLOBAL_REFERENCE_LINE =
  'Read the global agent instructions at `~/.pi/agent/AGENTS.md`';
```

Its semantics:

- **Defer to the global file** — when `~/.pi/agent/AGENTS.md` exists (the
  SorraAgents global install), agents should read it for core workflow
  instructions.
- **Local rules stay below the reference** — project-specific rules are added
  by the project owner in the `## Project-specific guidance` section (or kept
  in the existing local content when appending); the global file is never
  copied into the project.

When the reference is already present, `ensureAgentTemplateInstalled()`
returns `skipped: true, reason: 'global reference already present'` without
touching the file — re-running `wl init` never duplicates the reference or
template.

### O/A/M prompt

When `AGENTS.md` exists without the global reference and no `--agents-template`
flag is given, `promptAgentTemplateAction()` asks:

| Choice | Meaning | Effect |
|--------|---------|--------|
| **O** – Overwrite | Replace the existing AGENTS.md entirely | Destructive; no chance of conflict with existing content |
| **A** – Add reference | Prepend the global-reference template, keep existing content | Non-destructive; retains existing instructions below the reference |
| **M** – Manual | Skip; user manages AGENTS.md themselves | No-op; Worklog agent guidance is not installed |

### CLI flags

| Flag | Values | Behavior |
|------|--------|----------|
| `--agents-template` | `overwrite` (or `o`), `append` (or `a`), `skip` (or `m`/`manual`/`manage`) | Non-interactive action when AGENTS.md exists without the global reference |
| `--workflow-inline` | `yes`/`true`/`1`, `no`/`false`/`0` | Inline workflow template into AGENTS.md (`yes`) or not (`no`); omitted → interactive prompt |

`--agents-template skip` is the common choice for unattended init
(see [WL-0MKVRI3580RXZ54H], the `--agents-template` flag item).

### Idempotence

| Scenario | Result |
|----------|--------|
| No `AGENTS.md` | Installs template (global reference + project placeholder) |
| `AGENTS.md` with global reference | No-op — reference already present |
| `AGENTS.md` without reference, `--agents-template skip` | No-op |
| `AGENTS.md` without reference, `--agents-template overwrite` | Replaces file with template |
| `AGENTS.md` without reference, `--agents-template append` | Prepends template, keeps content below |
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
| **Install mechanism** | Copied (reference structure) | Symlinked |
| **Scope** | One project | All projects on the machine |
| **Content** | Canonical reference: `## Global agent guidance` + `## Project-specific guidance` placeholder | Full agent workflow: work-item lifecycle, workflow steps, push policy, types/priorities |
| **Drift risk** | Low — no duplicated content to keep in sync | Low — single source |

### Precedence

The `## Global agent guidance` section (installed by `wl init`) makes the
relationship explicit: the global file defines the core principles, the
Worklog (wl) work-item workflow, and the coding disciplines that apply to
every project. Project-specific rules live below the reference in
`## Project-specific guidance` and are added by the project owner — they are
**never** a copy of the global file.

### Duplication and conflict risk

The canonical template eliminates the previous duplication: the old template
carried CRITICAL RULES, work-item Types, priorities, and workflow guidance
that had to stay in sync with `AGENTS_GLOBAL.md` (the `docs` issue-type
addition had to be applied to both files). With the reference model, a change
to the global guidance is picked up by every project automatically.

## Interaction with the global install

- `wl init` installs its short canonical template unconditionally — the
  template self-references `~/.pi/agent/AGENTS.md`, so when the global file
exists (SorraAgents install) agents read both; when it does not, the
reference is harmless and the project still has its own `AGENTS.md`.
- There is **no delegation switch today** — no code path that says "if the
  global file exists, skip the template entirely." The template is short by
design so that no duplication occurs regardless of environment.

### Environments

| Environment | What agents see |
|-------------|-----------------|
| **Standalone** (no SorraAgents global install) | Only the project `AGENTS.md` (reference points at a file that does not exist — harmless) |
| **Global** (SorraAgents `install_pi.sh` run) | Both the global `~/.pi/agent/AGENTS.md` (symlinked from `AGENTS_GLOBAL.md`) and the project `AGENTS.md` (reference + project-specific rules) |

## Drift history

- **`docs` issue-type change** — previously required editing both
  `templates/AGENTS.md` and `AGENTS_GLOBAL.md` (drift risk confirmed in
  practice); the reference model removes this.
- **SorraAgents dedup items** (SA-0MSITKHPW002XG4G, SA-0MSIUUYRD002GC8W,
  SA-0MSITKOXI007XD4N — completed): SorraAgents adopted a
  "reference global instead of duplicating" model. Its own project
  `AGENTS.md` now starts with a short pointer to the global file instead of
  duplicating the full content. ContextHub's template has now followed with
  the same canonical structure (SA-0MSITKWBP007VUJS).

## Recommendation

**Adopt the single-source-of-truth model: delegate agent-guidance/workflow setup to the SorraAgents global install** (the reference-global pattern), with implementation tracked in WL-0MSIXMKOX0052514. The current model already emits the canonical reference structure; further delegation (skipping the template when the global install is detected) is tracked there.

### Evidence

1. **Duplication eliminated.** `templates/AGENTS.md` now emits only the
   canonical reference structure (3 lines) instead of the ~258-line
   instruction set that duplicated `AGENTS_GLOBAL.md`.
2. **SorraAgents already adopted the model.** SA-0MSITKHPW002XG4G,
   SA-0MSIUUYRD002GC8W, SA-0MSITKOXI007XD4N (completed) moved SorraAgents to
   reference-global: its project `AGENTS.md` now starts with a short pointer
   to `~/.pi/agent/AGENTS.md` instead of duplicating content.
3. **ContextHub's own project AGENTS.md already uses the pattern.** The
   installed `<projectRoot>/AGENTS.md` starts with a "Global agent guidance"
   section referencing `~/.pi/agent/AGENTS.md` — the template is now in step
   with the repo's own practice.
4. **Reference model has no downsides for the global environment.** When the
   SorraAgents install is present, the global file carries the canonical
   workflow; the project file only needs project-specific rules plus a
   reference line.

### What the change looks like (scope boundary — NOT implemented here)

- When the SorraAgents global install is detected (`~/.pi/agent/AGENTS.md`
  resolves to a SorraAgents symlink), `wl init` could skip emitting even the
  reference template. This is tracked in WL-0MSIXMKOX0052514; not
  implemented in this item.
- Standalone environments (no global install) keep the reference template so
  Worklog remains usable without SorraAgents.

## Related

- `src/commands/init.ts` — `ensureAgentTemplateInstalled`,
  `promptAgentTemplateAction`, `ensureWorkflowTemplateInstalled`,
  `CANONICAL_GLOBAL_REFERENCE_MARKER`, `WORKLOG_AGENT_TEMPLATE_RELATIVE_PATH`
- `templates/AGENTS.md`, `templates/WORKFLOW.md` — the installed templates
- `tests/cli/init.test.ts` — behavior tests (reference installation,
  idempotence, `--agents-template`, `--workflow-inline`)
- [docs/tutorials/01-your-first-work-item.md](tutorials/01-your-first-work-item.md) —
  the init walkthrough that mentions the AGENTS.md prompt
