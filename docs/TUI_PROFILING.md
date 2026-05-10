# TUI Profiling and Freeze Diagnostics

Use this guide to collect reproducible diagnostics for intermittent TUI keyboard freezes (for example: input pauses for 30–60 seconds and then recovers).

## Enable profiling

Profiling is **off by default**.

### Option A: `--perf` (recommended)

```bash
npm run cli -- tui --perf
# or
wl tui --perf
```

This enables:

- performance timing metrics (expand/collapse, scroll, etc.)
- keypress diagnostic events
- event-loop lag detection

### Option B: environment flag

```bash
TUI_PROFILE=1 npm run cli -- tui
# or
TUI_PROFILE=1 wl tui
```

Useful when you want diagnostics without changing command arguments.

## Optional chord-level debug logging

```bash
TUI_CHORD_DEBUG=1 TUI_LOG_VERBOSE=1 TUI_LOGFILE=./tui-debug.log npm run cli -- tui --perf
```

This records low-level chord activity to the file in `TUI_LOGFILE`.

## Known freeze reproduction path (WSL / slow-mounted filesystem)

Use this scenario to reproduce key-input stalls observed in WSL/Windows Terminal setups:

1. Write debug logs to a slow mount (for example `/mnt/c/...` in WSL).
2. Enable high-volume chord/debug logging.
3. Hold navigation keys (`j`, `k`, arrows) for 10–30 seconds.

Example:

```bash
TUI_CHORD_DEBUG=1 TUI_LOG_VERBOSE=1 TUI_LOGFILE=/mnt/c/Users/<you>/wl-tui-debug.log wl tui --perf
```

Expected signal during a bad run:

- `.worklog/tui-profiling-*.jsonl` contains repeated `event_loop_lag` entries.
- `keypress.handlerDurationMs` rises sharply during lag windows.

## Root-cause hypothesis and mitigation

Most severe stalls are consistent with synchronous file I/O on the input hot path (especially when debug logging is enabled on slow filesystems).

Mitigation implemented in this branch:

- TUI file logging now buffers and flushes asynchronously.
- Logging writes are bounded by an in-memory queue cap to prevent unbounded growth under sustained input.

## Output artifacts and default locations

When profiling is enabled, artifacts are written under your worklog directory (typically `.worklog/`):

- `.worklog/tui-performance.json` — structured performance metrics
- `.worklog/tui-profiling-<timestamp>-<pid>.jsonl` — JSONL diagnostics (keypress events, event-loop lag events, startup/shutdown markers)

If `TUI_LOG_VERBOSE=1` is also enabled:

- `./tui-prototype.log` by default, or `TUI_LOGFILE=<path>` when provided

## Collect system-call traces (Linux / WSL)

Use `strace` while reproducing the freeze:

```bash
strace -tt -f -o /tmp/wl-tui.strace wl tui --perf
```

Then attach these to the work item:

- `.worklog/tui-performance.json`
- `.worklog/tui-profiling-*.jsonl`
- `tui-debug.log` (if enabled)
- `/tmp/wl-tui.strace`

## Optional terminal session capture

```bash
asciinema rec /tmp/wl-tui-freeze.cast
wl tui --perf
# reproduce freeze, then exit and Ctrl-D
```

## Interpreting diagnostics quickly

- `event_loop_lag` records indicate the event loop was delayed beyond `TUI_EVENT_LOOP_LAG_MS` (default: 200ms).
- `keypress` events show key metadata and whether chords consumed the key.
- Long stretches without `keypress` processing, or repeated lag spikes, are strong indicators of blocking work on the main thread.

You can tune lag sensitivity:

```bash
TUI_EVENT_LOOP_LAG_MS=100 wl tui --perf
```
