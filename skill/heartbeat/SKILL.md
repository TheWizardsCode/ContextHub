---
name: heartbeat
description: "Automated work item monitoring — inspects the completed/in_review queue and either flags the next item for producer review (when sparse) or runs an audit on the first unverified item (when full). Trigger on queries like: '/skill:heartbeat'"
---

# Heartbeat Skill

## Completion-Detection Gate

Before running, the heartbeat checks whether the previous work has completed.
This prevents the heartbeat from interrupting work in progress.

1. Review the conversation history and find the **last assistant message**
   (the most recent message from the Pi agent, not the user).
2. If that message **clearly states that a process has completed**
   (e.g., "Work committed to dev", "Task complete", "All tests pass",
   a work-item summary with "Work committed to dev", or any message that
   unambiguously signals the end of a task), **proceed** to the heartbeat
   logic below.
3. If the last assistant message **does not clearly indicate completion**
   (e.g., it asks a question, reports an error, or is mid-process),
   print the following and exit **without** taking any heartbeat action:

   ```
   No completed process detected — heartbeat taking no action.
   ```

   Do NOT run `./scripts/heartbeat.py` in this case.

4. **Manual invocation override:** If the heartbeat was invoked manually
   by a user (not by a scheduler), the user's explicit request is sufficient
   evidence of intent — proceed directly to the heartbeat logic.

## Overview

The heartbeat skill automates work item queue monitoring. It inspects the
completed/in_review queue and takes one of three actions depending on queue
state:

- **Sparse queue (< 10 items):** Finds the next ready work item via `wl next`
  and flags it for producer review (`needsProducerReview: true`).
- **Full queue (>= 10 items):** Finds the first item (by `sortIndex`) that
  does **not** have a valid audit result ("Ready to close: Yes") and runs
  the audit runner on it.
- **All items ready:** Reports "Project is ready for producer review prior to
  a new release".

Only one audit is triggered per heartbeat invocation.

## Invocation

```
/skill:heartbeat
```

Invoke via the Pi chat interface. Output is displayed directly in the chat.

## Behavior

After passing the completion-detection gate above:

1. Run `python3 ./scripts/heartbeat.py` (or `python3 [--force]` for
   standalone/automated use).
2. The script queries `wl list --status completed --stage in_review --json`
   to count items.
3. **If count < 10 (sparse queue):**
   - Call `wl next --json` to find the next ready work item.
   - If found, set `needsProducerReview: true` via `wl update <id> --needs-producer-review true`.
   - Report which item was flagged.
   - If no item returned by `wl next`, report gracefully.
4. **If count >= 10 (full queue):**
   - Sort items by `sortIndex` ascending.
   - For each item, check for a valid audit result via `wl audit-show <id> --json`.
   - An item is considered "ready" if its `rawOutput` starts with "Ready to close: Yes".
   - Find the first non-ready item and run the audit skill's runner script.
   - Only one item is audited per invocation.
5. **If all items have "Ready to close: Yes":**
   - Report "Project is ready for producer review prior to a new release".

## Inputs

None (when invoked via `/skill:heartbeat`). The skill operates on the current
state of the Worklog database.

The underlying script accepts:

- `--force` — Bypass the completion-detection gate. Use when running the
  script standalone (e.g., from CI, cron, or a scheduler that already
  performs its own idle/completion checks).

## Outputs

Human-readable text printed to stdout (displayed in the Pi chat interface).

## Exit Codes

- 0 — Success (action taken or all items ready)
- 1 — Error (wl command failure, JSON parse error)

## Dependencies

- `wl` CLI (Worklog) — must be installed and in PATH
- Audit skill — located at `~/.pi/agent/skills/audit/`
- Python 3 — for running the heartbeat script and audit runner

## Key Files

- `skill/heartbeat/SKILL.md` — This file
- `skill/heartbeat/scripts/heartbeat.py` — Core implementation script
- `tests/skill/heartbeat/test_heartbeat.py` — Unit tests

## Related Work Items

- WL-0MLQ0ZHQE0JBX8Y6 — TUI filter shortcut for needsProducerReview
- WL-0MLGTWT4S1X4HDD9 — `--needs-producer-review` filter for `wl list`
- WL-0MR6XG7RX008AF2W — Closing question in audit skill output
- WL-0MLYTKTI20V31KYW — Structured audit report format
- WL-0MM347F9D1EGKLSQ — sortIndex selection with batch mode
- WL-0MRJATQJ900832IT — Completion-detection gate
