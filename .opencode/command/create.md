---
title: create
description: Create a Worklog work-item from the TUI OpenCode prompt.
tags: [worklog, create, tui]
agent: opencode
---

# /create command

Usage: /create <short title or description>

Summary:
This OpenCode command creates a new Worklog work-item using the text the user types after `/create` in the TUI prompt. It builds a concise title, a detailed description containing the original text and metadata, and chooses an appropriate priority and issue-type. The command then runs `wl create` to create the work item and returns the created work-item JSON to the TUI response pane.

Behavioral notes for the agent handling this command:

- Extract the raw user input from the special variable `$ARGUMENTS` (the text after `/create`).
- Construct a short title by taking the first 72 characters of the input (trim trailing whitespace and punctuation). If the input is empty, use "New work item" as a fallback title.
- Build a detailed description that includes:
  - The full verbatim user-provided text.
  - A metadata section stating that the item was created via `/create` from the TUI and the agent that created it.
  - A Recommended "Open Questions" section if the user text is ambiguous or missing critical details.
- Choose issue-type and priority conservatively:
  - If the text contains words like "bug", "fix", "error", or describes a failing test, prefer issue-type `bug` and priority `high`.
  - If the text describes a user-visible change or feature, prefer `feature` and priority `medium`.
  - Otherwise default to issue-type `task` and priority `medium`.
- Do NOT automatically set a parent. The work item ID provided as context (e.g. "The work item for this request is WL-XXXX") is the currently selected item in the TUI and must NOT be used as `--parent`. Only include `--parent <ID>` if the user explicitly states that the new item should be a child of a specific work item (e.g. "child of WL-1234", "subtask of WL-1234", "under WL-1234").

Execution (what the command should run):

The handler should run `wl create` with a heredoc-style description to preserve formatting. Example (pseudo-shell; the TUI/agent should construct and run an equivalent command):

wl create --title "<TITLE>" --description "$(cat <<'EOF'
<FULL_DESCRIPTION>
EOF
)" --priority <priority> --issue-type <issue_type> --json

Where:
- <TITLE> is the generated short title (shell-escaped)
- <FULL_DESCRIPTION> is the detailed description (preserve newlines)
- <priority> is one of: critical, high, medium, low
- <issue_type> is one of: bug, feature, task, chore, epic

Security and least-privilege rationale:

- This command only uses the `wl` CLI to create work items. It does not run arbitrary shell commands or modify repository files. That restricts the scope of the command to work-item creation only.
- The command handler must ensure all data passed to the shell is properly escaped (use heredoc or equivalent) to avoid injection risks.
- The command will not attempt to close, update, delete, or otherwise mutate existing work items without explicit additional user action.

Examples of use:

- /create Fix login page redirect when session expires
- /create Investigate intermittent database connection errors seen in staging

Acceptance criteria (for reviewers):

- The file `.opencode/command/create.md` exists and documents the prompt template and execution semantics.
- The command instructs the agent to invoke `wl create` with a preserved, escaped description.
- The command is conservative about permissions and documents security considerations.

Implementation notes for integrators:

- Add `/create` to AVAILABLE_COMMANDS in src/tui/constants.ts so it appears in autocomplete (this file is not modified here). Integrators should ensure the TUI passes the remainder of the input into `$ARGUMENTS` when invoking the command.
- Tests: handlers that execute this command in automated tests should stub or mock `wl create` to avoid creating real work items.

Rationale (audit trail for Producers and downstream agents):

This command file provides a minimal, auditable bridge between the TUI and Worklog. It follows the principle of least privilege by only invoking `wl create` and by prescribing conservative defaults for priority and issue-type. The file documents how titles and descriptions are derived so downstream agents and auditors can reproduce or review the behaviour. Any change that broadens the permission scope (for example allowing edits to existing work items) must be approved by a Producer before being committed.
