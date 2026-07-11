# OpenBrain Integration

This project can optionally submit concise markdown summaries of completed work items to an external knowledge base called "OpenBrain". The integration is intentionally conservative: submissions are fired-and-forget so they never block or fail the user CLI flow, and failures are recorded to a local retry queue for later inspection/resubmission.

Overview
--------
- When a work item transitions to `completed` (via `wl close` or `wl update --status completed`) the CLI will attempt to submit a short markdown summary to OpenBrain.
- Submission is done by invoking the OpenBrain CLI `ob add --stdin --title <title>` and passing the generated markdown on stdin.
- The submission is non-blocking: the CLI spawns the child process and returns; submission errors are logged and the entry is appended to a local JSONL retry queue.

Where to find the integration
-----------------------------
- Implementation: `src/openbrain.ts`
- CLI hooks: `src/commands/close.ts` and `src/commands/update.ts` call `submitToOpenBrain(...)` when status transitions to `completed`.
- Unit tests: `tests/unit/openbrain.test.ts`
- Integration tests: `tests/cli/openbrain-close.test.ts`

Configuration
-------------
Enable the feature in your project configuration (`.worklog/config.yaml`):

```yaml
openBrainEnabled: true
```

By default the integration expects the `ob` CLI to be available on PATH. You can override the binary path with the `WL_OB_BIN` environment variable (or set it for a single invocation):

```bash
WL_OB_BIN=/usr/local/bin/ob wl close WL-0001 -r "done"
```

Behavior & fallbacks
--------------------
- If spawning the `ob` binary fails (for example `ENOENT`) the failure is logged and a JSON object describing the submission is appended to the retry queue file: `.worklog/openbrain-queue.jsonl`.
- If the child process exits with a non-zero status the stderr text (if any) is captured and recorded together with the queued entry.
- Queued entries are written as one JSON object per line with the following fields:
  - `workItemId` — the originating Worklog id
  - `title` — the work item title
  - `summary` — the markdown summary that would have been sent to OpenBrain
  - `enqueuedAt` — ISO timestamp when the entry was queued
  - `reason` — optional human-readable reason for queuing (spawn error or stderr)

Summary format
--------------
Summaries are produced by `buildOpenBrainSummary(item)` (see `src/openbrain.ts`). The produced markdown contains:

- A top-level heading with the work item title
- A short metadata block containing the work item id, type, assignee and completed timestamp
- An `## Objective` section containing the item's description (if present)
- An `## What was done` section containing the (redacted) audit text if present

Security & Redaction
---------------------
Audit text is redacted before it's persisted or submitted. See `src/audit.ts` for the redaction rules (email-like local parts are obfuscated). OpenBrain submissions therefore use the same redacted audit text shown in human output. Always review your redaction policy before enabling OpenBrain on repositories containing sensitive data.

Developer notes
---------------
- Module entrypoints:
  - `submitToOpenBrain(item, options?)` — spawn the `ob` process and write the markdown summary to stdin. Options allow overriding the `ob` binary, the spawn implementation (useful for tests), the queue directory, and whether to wait for completion.
  - `appendToQueue(entry, queueDir?)` — append a JSONL retry entry to the configured worklog directory.
  - `resolveObBinary()` — resolves the `ob` binary with respect for `WL_OB_BIN`.
- Queue file name constant: `OPENBRAIN_QUEUE_FILE` (`openbrain-queue.jsonl`)

Resubmitting queued entries
---------------------------
The integration does not currently provide an automated resubmission command. To retry queued entries manually you can inspect and resubmit them with a short script. Example (POSIX shell + `jq`):

```bash
QUEUE=.worklog/openbrain-queue.jsonl
if [ -f "$QUEUE" ]; then
  while IFS= read -r line; do
    title=$(echo "$line" | jq -r '.title')
    echo "$line" | jq -r '.summary' | ob add --stdin --title "$title" || echo "Resubmit failed for $title"
  done < "$QUEUE"
fi
```

Replace `ob` with the path in `WL_OB_BIN` if necessary. Be careful when resubmitting to avoid duplicate entries in OpenBrain.

Testing
-------
- Unit tests for the integration are in `tests/unit/openbrain.test.ts` and validate summary construction, queue writing and spawn/error handling.
- CLI-level integration tests that exercise `wl close` / `wl update` behaviours are in `tests/cli/openbrain-close.test.ts`.

Questions / TODO
----------------
- A future enhancement could provide a `wl openbrain resubmit` command that safely retries queued entries and records outcomes in worklog comments.
