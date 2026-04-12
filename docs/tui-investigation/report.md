# TUI Investigation Report

This document captures a deep investigation into the reliability problems observed in the current TUI (based on Blessed), research into alternative libraries, a recommendation, and a migration plan with milestones and estimates.

Date: 2026-04-12
Author: opencode

Summary
- The existing TUI implementation is heavily coupled to blessed and contains numerous defensive workarounds for terminal capability parsing, widget lifecycle differences, and cursor/key handling. Many failure modes are caused by differences between blessed versions, terminfo/tput parsing, and fragile event listener/cursor handling.
- Recommendation (short): Replace the TUI with an Ink-based implementation (Ink + small set of community Ink components) and keep a short-term blessed-stability remediation track for critical issues. Ink provides better developer ergonomics (React component model), easier testing, and stronger component reusability which will reduce long-term maintenance cost.

Key findings (audit of current usage)

- Heavy blessed reliance and brittle startup paths
  - controller.ts uses try/catch around createLayout and falls back to a safe TERM value (xterm-256color) when terminfo parsing errors occur. This is a strong indicator of runtime fragility: code paths in createLayout and blessed.program.tput are treated as unreliable.
  - Many comments and guarded calls throughout the TUI code handle widget lifecycle differences across blessed versions and test-doubles (try/catch around removeAllListeners, destroy, grabKeys, program methods).

- Dialogs and multiline inputs are a major source of instability
  - Dialog code (components/dialogs.ts and controller.ts) implements custom cursor management, manual program.cup/cuf/cud/cuu calls, and custom _updateCursor overrides to work around blessed internals. These are fragile across blessed/terminal combinations and are likely a top source of failing human-interaction dialogs.
  - There are multiple best-effort cleanup paths (endUpdateDialogCommentReading, endOpencodeTextReading) that swallow errors; while this prevents crashes it also hides root causes and leads to inconsistent state (cursor visible, grabKeys left set, listeners retained).

- Virtualization + selection synchronization
  - The code uses a VirtualList manager and translates between blessed's visible slice and the global index. This adds complexity; incorrect coordination of offsets or widget selection can produce apparent UI mis-selection or jumps.

- Event/key handling complexity
  - Chord handling, custom comment key handlers, and manual Tab/Shift-Tab wiring are implemented ad-hoc and guarded with try/catch. Differences in blessed versions and in-screen API (program.key vs widget.key vs screen.key) cause different code paths to execute and result in inconsistent behaviour.

- Test doubles and masked failures
  - Comments frequently note that test doubles for blessed do not implement `.on` or other APIs. The production code attempts to tolerate missing calls which complicates reproducing issues in unit tests and can mask real failures.

Representative failure modes and repro notes

- Terminal capability parse error on startup under tmux
  - Symptom: wl tui fails to initialize layout; logged message recommending TERM=xterm-256color.
  - Root cause: terminfo/tput parsing differs across environments; blessed or its program.tput parser throws.
  - Repro: Run under tmux with TERM=tmux-256color (reported in code as shouldUseSafeTerminalFallback).

- Dialog input loses cursor / input not accepted
  - Symptom: typing in multiline comment textarea does not reflect in UI, cursor remains invisible, keys are swallowed or mis-routed.
  - Root cause: inconsistent use of grabKeys, manual showCursor/hideCursor, and custom _updateCursor logic. If a cleanup path fails to run, the terminal may be left in a state where input is not routed.
  - Repro: Open update dialog, focus comment, use arrow keys and insert text; try closing dialog via a hotkey and reopen.

- Selection jumps when using virtualized list
  - Symptom: selection index appears to jump unexpectedly when list is updated or when filtering/expanding nodes.
  - Root cause: arithmetic bugs or edge cases in virtualList offset handling combined with `list.selected` vs global index mapping and occasional mismatch between setItems/select calls.
  - Repro: Use large dataset, enable virtualization (default), perform filter/expand operations while rapidly moving selection.

Alternatives evaluated

1) Ink (https://github.com/vadimdemedes/ink)
   - Type: React-like rendering to terminal
   - Stability: Actively maintained, wide adoption, stable API
   - Accessibility: Basic support via semantic components; accessibility to screen readers varies by terminal
   - Developer ergonomics: Excellent — React mental model, declarative components, good testability
   - Component reusability: Strong — many community components (ink-text-input, ink-select-input, ink-spinner, ink-box)
   - Risks: Requires re-implementation of existing UI (non-trivial) and learning curve if team isn't familiar with React in terminal.

2) Ink + custom component library (Ink + community components)
   - Type: Same as Ink, plus building a small internal component library modelled after the current components
   - Pros: Accelerates dev and enforces consistent patterns; migration can be done component-by-component.

3) neo-blessed / blessed forks (neo-blessed, maintained blessed forks)
   - Type: API-compatible blessed forks
   - Stability: Varies; may be maintained better than original blessed in some forks
   - Developer ergonomics: Same as blessed (imperative), so existing code can be adapted with fewer changes
   - Component reusability: Limited; still imperative widget creation
   - Risks: If API differences exist between environments this only delays future problems and keeps low-level fragility.

4) terminal-kit (https://github.com/cronvel/terminal-kit)
   - Type: High-level terminal library with many primitives
   - Stability: Actively maintained
   - Developer ergonomics: Lower-level than Ink but different API that may be simpler for some flows
   - Component reusability: Less structured than React; may require more infra.

5) Enquirer / prompts (interactive prompts)
   - Type: Prompt-focused libraries; not full-screen TUIs
   - Fit: Good for simple dialogues and prompts, not a full replacement for a multi-pane TUI.

Assessment matrix (summary)
- Ink (recommended): Best long-term maintainability, testability and developer ergonomics. Higher initial migration cost but yields reusable components and fewer low-level terminal hacks.
- neo-blessed forks: Lower migration cost but retains many blessed fragilities; recommended only if replacement cost is prohibitive and short-term stability is required.
- terminal-kit: Useful alternative for imperative UI but less structured than Ink.
- Enquirer/prompts: Good for targeted prompts (e.g. replacement of specific dialogs) but not full TUI.

Recommendation and rationale

- Replace the TUI with an Ink-based implementation (Ink + a small internal components library modelled after current UI pieces). Rationale:
  - The present codebase contains many fragile, blessed-specific workarounds (cursor/capability parsing, manual program.* cursor movements, complex event wiring). These issues are structural and will continue to require brittle fixes if we stay on blessed.
  - Ink provides a declarative React model enabling component reusability, straightforward unit testing, and a more modern developer experience. It will make it easier to implement deterministic input handling and avoid direct program.cup/cuf calls.
  - Migration can be phased: prototype a minimal Ink UI and iterate component-by-component while keeping the blessed UI as a fallback during migration.

Short-term mitigations (if immediate stability is required)

- Create a small hotfix PR to address the most frequent and highest-impact failure modes:
  - Ensure cleanup helpers always run (add robust finally/cleanup and better logging for endUpdateDialogCommentReading and endOpencodeTextReading).
  - Centralize and assert grabKeys/program state transitions so grabKeys is always restored on all dialog close paths.
  - Add additional logging (when verbose) for lifecycle and error branches so failures are visible in telemetry/CI.

Migration plan (milestones, estimates, risks)

Proposed branch name: wl-WL-0MNVHYNQ700342JH-tui-migration-ink

Phase 0 — Prototype (2-4 dev days)
  - Goal: Build a minimal Ink prototype that renders the left list, detail pane, and a single modal dialog with text input and selection.
  - Deliverable: Prototype branch + demo instructions.
  - Risk: Minor — validates approach quickly.

Phase 1 — Component library and core flows (1-2 sprints)
  - Break down into component tasks: List, DetailPane, MetadataPane, Toasts, Overlays/Dialog, OpencodePane.
  - Implement key interactions and keyboard handling using React hooks and Ink events.
  - Deliverable: Working Ink-based TUI for core workflows; test coverage for interactions.
  - Risk: Medium — reconciling virtualization behaviour requires careful implementation; consider using a virtualized list component or implementing a simple viewport manager in React.

Phase 2 — Tests & CI (3-5 days)
  - Add automated tests: unit tests for components and an e2e harness using a headless terminal emulator (e.g., node-pty + expect-like assertions) to validate key flows and ensure no terminal state leaks.
  - Deliverable: CI job that runs TUI e2e tests in headless mode.
  - Risk: Medium — building stable headless tests needs careful terminal emulation config.

Phase 3 — Parallel run & rollout (1 sprint)
  - Run Ink TUI in parallel behind a feature flag or environment variable; gather feedback from users; keep blessed code as fallback.
  - Create migration tasks for docs and small UX tweaks.

Phase 4 — Cutover and cleanup (1 sprint)
  - Remove blessed-based code after thorough testing and deprecation period.

Estimates (rough, team-dependent)
- Prototype: 2-4 dev days
- Core component port (List, Detail, Dialogs, Overlays, Toast): 2-4 weeks (depending on scope and QA)
- Tests and CI: 3-5 days
- Rollout and polish: 1-2 weeks

Risks
- Migration complexity for virtualization: The current VirtualList implementation must be replicated or replaced by an Ink-friendly virtualized list. Incorrect handling can re-introduce selection jitter.
- Terminal/tty behavior: Differences in terminal capabilities still exist; Ink reduces low-level handling but doesn't eliminate terminal quirks. Headless tests and CI coverage reduce risk.
- Developer ramp: Team needs to adopt Ink patterns; allocate time for knowledge transfer.

Suggested next work items (child tasks)

1. Prototype Ink-based TUI (WL task) — priority: high — create prototype and validate core interactions.
2. Port core components to Ink (WL task) — priority: high — List, Detail, Dialog, Overlays, Toast.
3. Add headless e2e TUI tests (WL task) — priority: high — node-pty harness and CI job.
4. Short-term blessed stability fixes (WL task) — priority: high — address cleanup and grabKeys/cursor issues.
5. Migration coordination and rollout plan (WL task) — priority: medium — docs, telemetry, feature flag.

Appendix: Concrete code observations

- controller.ts
  - Uses a safe fallback terminal (xterm-256color) on terminfo parse errors (lines around createLayout try/catch). This indicates handling of environment-specific terminfo parsing bugs.
  - Many guarded try/catch around widget methods and reliance on hidden fields (e.g., __opencode_focus, __opencode_blur) to store handlers and then remove them on destroy.

- components/dialogs.ts
  - updateDialogComment overrides cursor positioning and directly calls program.cup / cuf / cud / cuu (custom _updateCursor implementation). This is fragile and depends on blessed internals.
  - Many layout and resize heuristics to keep textareas inside dialog bounds.

Files scanned during this investigation
- src/tui/controller.ts
- src/tui/layout.ts
- src/tui/components/dialogs.ts
- src/tui/components/* (overview)

Decision
- Replace: Ink-based TUI (short-term blessed fixes tracked separately).

If you want I will:
1) Create the prototype and child work-items (I will create suggested WL child tasks and attach them to WL-0MNVHYNQ700342JH).
2) Open a small PR with short-term stability fixes for Blessed to stop the most common breaks.
