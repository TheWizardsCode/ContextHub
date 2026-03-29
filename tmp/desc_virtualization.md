# Summary
Replace the current list rendering with a virtual‑scroll implementation that only materializes visible rows, improving performance for large work‑item trees.

## Acceptance Criteria
- Benchmark harness shows ≤ 200 ms latency even when the JSONL file grows to ~5 k items.
- Scrolling remains smooth and UI state (expanded nodes, selections) persists correctly.

## Minimal Implementation
- Introduce a small virtual‑list library (e.g., `blessed-contrib` or a custom viewport) into `src/tui/layout.ts` as an alternative renderer.
- Wire it via a `--virtualize` flag.
- Add unit tests for the virtual list’s indexing logic.
