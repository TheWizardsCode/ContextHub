# Herdr Shared Scripts

This directory contains shared shell scripts and documentation for Herdr plugin
development. These scripts are consumed by multiple Herdr plugins across different
repositories (e.g., ContextHub, open_source_llm).

## Contents

| File | Description |
|------|-------------|
| `send-to-pi.sh` | Open a Pi agent pane and send a command. Generalized with `--pane-name`, `--focus`/`--no-focus`, `--resize`/`--no-resize`, `--check-cli`, `--cwd`, and `--model` options. |
| `open-pi-agent.sh` | Open an interactive Pi session in a new pane. Generalized with `--pane-name`, `--focus`/`--no-focus`, `--resize`/`--no-resize`, and `--cwd` options. |
| `grid.py` | Python grid-rebalance helper: grows an even-completion 2-column grid to the right of the anchor pane (validated against herdr 0.7.5). |
| `herdr-agent-state-protocol.md` | Specification for Herdr Unix socket agent state reporting protocol. |

## Pane-launch modes: `--resize` (default) / `--no-resize`

Both scripts launch a new pane to the right of the current (anchor) pane and
support two launch modes:

- **`--resize`** (default) — split right AND rebalance the right side into an
even 2-column grid filled top-to-bottom. The anchor pane keeps 50% width
× 100% height; the grid grows one pane per launch (odd additions extend the
left column, even additions complete a row on the right; odd counts show one
temporary tall cell that completes at the next addition).
- **`--no-resize`** — plain `herdr pane split --direction right` with no layout
changes (herdr default behavior).

Resize mode resolves the anchor pane via `herdr pane current`, invokes the
`grid.py` helper (which performs the split and rebalance over the herdr Unix
socket using only safe operations: `pane.split` + `layout.set_split_ratio`),
and uses the returned pane id for the subsequent `pane run` / `pane rename` /
`pane zoom` steps. If `grid.py` fails, the script exits non-zero with a clear
message (retry with `--no-resize` for a plain split).

Environment overrides:

- `HERDR_GRID_BIN` — path to the grid helper (default: `grid.py` next to this script)
- `HERDR_BIN_PATH` — path to the herdr CLI binary (default: `herdr` on PATH)
## Working directory of new panes

By default Herdr creates new panes with a `follow` CWD policy, which inherits
the **source pane's** working directory. When a plugin spawns one of these
scripts from its own installation directory, the resulting pane (pi agent or
command output) would start in the plugin directory — not the user's project.

To ensure the new pane operates in the correct project, both scripts accept a
`--cwd <path>` option and resolve the target CWD in priority order:

1. `--cwd <path>` argument
2. `HERDR_RESOLVED_CWD` environment variable (set by the worklist plugin's
   `open.sh`/`toggle.sh` to the user's actual project directory)
3. `$PWD` of the calling process

The resolved target is passed to `herdr pane split --cwd <path>`, so the new
pane starts in the correct project root and `wl` commands, skills, and
relative paths resolve against the user's project rather than the plugin's
installation directory.

## Selecting the pi model

`send-to-pi.sh` accepts a `--model <pattern>` option that is forwarded to the
`pi` CLI invocation (`pi --model <pattern> '<command>'`), so callers can open
the agent pane with a specific model (e.g. the herdr worklist plugin forwards
the `model` field from its `shortcuts.json` entries). When `--model` is
omitted, no `--model` flag is passed and pi uses its default model.

## Usage

These scripts are consumed as a git submodule from other repositories.

### Adding as a submodule

```bash
git submodule add git@github.com:SorraTheOrc/ContextHub.git packages/ContextHub
```

### Consuming `send-to-pi.sh`

Refer to the shared script from a consumer project's own wrapper:

```bash
# consumer-project/scripts/send-to-pi.sh
shared_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../packages/ContextHub/packages/herdr/shared/send-to-pi.sh"
exec "$shared_script" --pane-name "Reviews" --no-focus "$@"
```

### Consuming `open-pi-agent.sh`

```bash
# consumer-project/scripts/open-pi-agent.sh
shared_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../packages/ContextHub/packages/herdr/shared/open-pi-agent.sh"
exec "$shared_script" --pane-name "Pi Agent"
```

## Agent State Protocol

See [herdr-agent-state-protocol.md](./herdr-agent-state-protocol.md) for the
full specification of how Herdr plugins report agent identity and state
transitions via Unix domain socket.

## Options

See individual script `--help` output for full option documentation.
