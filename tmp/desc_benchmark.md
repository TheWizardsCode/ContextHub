# Summary
Build an automated script that expands/collapses a 30‑item tree repeatedly and asserts a 200 ms max latency.

## Acceptance Criteria
- Script runs headlessly and reports “PASS” only if every measured operation ≤ 200 ms.
- Failing runs output the measured latency and a brief stack trace.

## Minimal Implementation
- Write a Node script `bench/tui-expand.js` that launches the TUI in a virtual screen (using `blessed`’s mock mode).
- Reuse the instrumentation from Feature 1 to capture timings.
- Add it to the test suite (`npm test` or equivalent).
