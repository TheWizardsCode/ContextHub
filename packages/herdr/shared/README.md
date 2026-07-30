# Herdr Shared Scripts

This directory contains shared shell scripts and documentation for Herdr plugin
development. These scripts are consumed by multiple Herdr plugins across different
repositories (e.g., ContextHub, open_source_llm).

## Contents

| File | Description |
|------|-------------|
| `send-to-pi.sh` | Open a Pi agent pane and send a command. Generalized with `--pane-name`, `--focus`/`--no-focus`, and `--check-cli` options. |
| `open-pi-agent.sh` | Open an interactive Pi session in a new pane. Generalized with `--pane-name` and `--focus`/`--no-focus` options. |
| `herdr-agent-state-protocol.md` | Specification for Herdr Unix socket agent state reporting protocol. |

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
