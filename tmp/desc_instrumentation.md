# Summary
Insert lightweight timers around expand/collapse and scroll actions to capture latency.

## Acceptance Criteria
- Recorded timestamps appear in TUI debug output for every expand/collapse event.
- Data can be exported to a JSON file for later analysis.

## Minimal Implementation
- Use `performance.now()` (or Node’s `process.hrtime`) in `src/tui/controller.ts` around the layout recompute calls.
- Create a simple logger module that writes metrics to `.tui-perf.log`.
- Add a command‑line flag `--perf` to enable/disable the instrumentation.
