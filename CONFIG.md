# Configuration

Worklog uses a two-tier configuration system with team defaults and local overrides.

## First-Time Setup

Initialize your project configuration:

```bash
wl init
```

This will prompt you for:

- **Project name**: A descriptive name for your project
- **Issue ID prefix**: A short prefix for your issue IDs (e.g., WI, PROJ, TASK)
- **Auto-sync**: Enable automatic git sync after changes (optional)

`wl init` installs `AGENTS.md` in the project root with the canonical global-reference structure: a `## Global agent guidance` section pointing at the global `~/.pi/agent/AGENTS.md` file, plus a `## Project-specific guidance` placeholder for the project owner to fill in (never a copy of the global instruction set). If `AGENTS.md` already exists, it prompts before adding the global reference and preserves the existing content (unless you pass `--agents-template` for unattended runs). When workflow templates are available, `wl init` prompts you to choose between no formal workflow, a basic Worklog-aware workflow, or manual management (unless you pass `--workflow-inline` for unattended runs).

**Note:** If you haven't installed the CLI globally, you can use `npm run cli -- init` for development.

### Unattended Initialization

You can run `wl init` in unattended mode by supplying all required values on the command line:

```bash
wl init --project-name "My Project" --prefix PROJ --auto-export yes --auto-sync no --agents-template append --workflow-inline yes --stats-plugin-overwrite no
```

- `--workflow-inline yes` selects the basic workflow option. Use `--workflow-inline no` to skip workflow setup.
- `--agents-template append` inserts the canonical global-agents reference at the top of your local `AGENTS.md` while preserving existing content below it.

### Example

```
Project name: MyProject
Issue ID prefix: MP
```

This will create issues with IDs like `MP-0J8L1JQ3H8ZQ2K6D`, `MP-0J8L1JQ3H8ZQ2K6E`, etc.

## Scheduled-prompts config (`.worklog/scheduled-prompts.json`)

`wl init` provisions a project-local scheduled-prompts config file at
`.worklog/scheduled-prompts.json` (create-if-absent — re-running `wl init`
never clobbers an existing file, so user edits and runtime state are
preserved). The file is consumed by the herdr plugin's downtime worker:
the worker dispatches each due prompt's text in a pi agent pane during
local-LLM idle time on a best-effort cadence (WL-0MSS1Q5ER007QDKX).

The base set provisioned on a fresh init:

```json
{
  "entries": [
    {
      "id": "/skill:refactor",
      "prompt": "/skill:refactor",
      "intervalDays": 3,
      "lastTriggeredAt": null
    }
  ]
}
```

Each entry carries:

- `id` — stable entry id (used for the pane name `Downtime <id>` — set it
  to the command/skill itself, e.g. `/skill:refactor`, so the pane name
  clearly identifies the scheduled command — and the rolling dispatch-log
  marker),
- `prompt` — any text the pi agent pane can run (e.g. `/skill:refactor`),
- `intervalDays` — best-effort frequency in whole days (a delayed dispatch
  never fires more often than the frequency),
- `lastTriggeredAt` — ISO-8601 UTC datetime of the last dispatch
  (`null` = never run; missing is treated as due).

Add, remove, or adjust entries by editing the file directly — no code
changes needed. The file is gitignored (part of `.worklog/`). See the herdr
downtime-worker docs in `packages/herdr/README.md` for the dispatch
semantics (freeze gating, fail-closed absent/malformed handling, cooldown
interaction).

## Configuration Override System

The system loads configuration in this order:

1. First loads `.worklog/config.defaults.yaml` if it exists (team defaults)
2. Then loads `.worklog/config.yaml` if it exists (your overrides)
3. Values in `config.yaml` override those in `config.defaults.yaml`

### Default Configuration

`.worklog/config.defaults.yaml` is committed to version control and contains the team's default settings.

### Local Configuration

`.worklog/config.yaml` is **not** committed to version control. It contains user-specific overrides.

**For teams**: Commit `.worklog/config.defaults.yaml` to share default settings. Team members can then create their own `.worklog/config.yaml` to override specific values as needed.

**For individual users**: If no defaults file exists, just use `wl init` to create your local `config.yaml`.

If no configuration exists at all, the system defaults to using `WI` as the prefix.

## GitHub Settings

Optional GitHub settings (edit `.worklog/config.yaml` manually):

- `githubRepo`: `owner/name` for GitHub Issue mirroring
- `githubLabelPrefix`: label prefix (default `wl:`)
- `githubImportCreateNew`: create work items from unmarked issues (default `true`)

See [DATA_SYNCING.md](DATA_SYNCING.md) for full sync workflow details (git-backed + GitHub Issues).

## Agent Onboarding (AGENTS.md)

AGENTS.md (the repository-facing onboarding/instructions file) is installed or updated by `wl init` when you consent during initialization. `wl init` is the canonical setup command: it writes config, attempts to install hooks, and can add the Worklog-aware AGENTS.md template into your repository. The installed template contains only a reference to the global `~/.pi/agent/AGENTS.md` (which carries the core work-item workflow and coding disciplines) plus a `## Project-specific guidance` placeholder — project-specific rules are added by the project owner, never by copying the global file.

If you prefer to manage onboarding files manually, create an `AGENTS.md` in your project root with guidance for agents and contributors (the `templates/AGENTS.md` in the Worklog package is a good starting point). If you want concise Copilot guidance, add a `.github/copilot-instructions.md` file pointing at your AGENTS.md and key commands.

## Git Hooks

Worklog can install lightweight Git hooks to keep the local JSONL data in sync automatically:

- **Pre-push hook**: Installed by `wl init` when possible. Runs `wl sync` before pushes so your exported `.worklog/worklog-data.jsonl` is merged and pushed. To skip, set `WORKLOG_SKIP_PRE_PUSH=1`. The hook avoids recursion when pushing the internal worklog ref.
- **Post-pull hooks**: `post-merge`, `post-checkout`, and `post-rewrite` are also attempted by `wl init`. They run `wl sync` after pull/merge/checkout events so the local database is refreshed/merged from the updated JSONL automatically. To skip, set `WORKLOG_SKIP_POST_PULL=1`.

Notes:

- The installer is conservative: it will not overwrite existing user hooks. If a hook file already exists, Worklog will skip installing its hook for that file and report the reason during `wl init`.
- Hooks are simple shell scripts that call the Worklog CLI if it is available on your PATH; if not found they are no-ops and will not block Git operations.

See [GIT_WORKFLOW.md](GIT_WORKFLOW.md) for detailed hook configuration and team workflow patterns.

## Windows Notes

On Windows, global installs can require an updated PATH and a new shell session.

```powershell
npm config get prefix
```

Ensure the returned prefix directory is on your PATH (and for most setups, the `prefix` root contains the generated `wl.cmd`/`worklog.cmd` shims). After updating PATH, open a new PowerShell/CMD/Git Bash session and verify:

```powershell
where wl
wl --help
```

If you are developing locally and want a reliable no-global-install path on Windows, use:

```bash
npm run cli -- <command>
```
