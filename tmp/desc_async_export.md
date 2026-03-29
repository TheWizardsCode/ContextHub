# Summary
Move heavy file I/O (reading/writing JSONL) off the main event loop to prevent UI freezes during database updates.

## Acceptance Criteria
- UI remains responsive (no "frozen" state) while a large JSONL export runs in the background.
- No data loss or corruption; exported file matches the SQLite state.
- A non‑blocking progress indicator appears in the TUI status bar.

## Minimal Implementation
- Wrap `exportToJsonl` and `refreshFromJsonlIfNewer` in `setImmediate`/`process.nextTick` or use a Worker thread.
- Show a progress indicator in the TUI status bar while the background task runs.
