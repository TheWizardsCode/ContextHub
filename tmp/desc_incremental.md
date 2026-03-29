# Summary
Refactor the TUI layout to perform incremental rendering, updating only the newly visible nodes on expand/collapse instead of recomputing the entire tree.

## Acceptance Criteria
- Measured latency on the benchmark harness drops below 200 ms for the 30‑item tree.
- No regression in existing UI functionality (manual smoke test passes).

## Minimal Implementation
- Refactor `src/tui/layout.ts` to separate “full tree layout” from “visible node layout”.
- Update `expandInProgressAncestors` to call the new incremental layout only for affected branches.
- Disable full recompute by default, gated behind a config flag `enableFullLayout`.
