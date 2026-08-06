#!/usr/bin/env bash
# install-herdr.sh — idempotent Herdr integration installer for Worklog
#
# Links the `worklog-selection-list` Herdr plugin and registers the
# `prefix+l` keybinding in the Herdr config, so the worklist works out of
# the box after `npm run build` (invoked via the root `postbuild` hook).
#
# Safe to run on every build:
#   - Re-linking the plugin is a no-op (herdr's own idempotence).
#   - The keybinding block is inserted only when a binding for
#     `worklog-selection-list.open-worklist` is not already present.
#   - Missing herdr binary or an unwritable config only warn (exit 0), so
#     `npm run build` never fails in CI/offline environments.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Config resolution matches herdr itself: HERDR_CONFIG_PATH overrides,
# otherwise ~/.config/herdr/config.toml.
CONFIG_PATH="${HERDR_CONFIG_PATH:-${HOME}/.config/herdr/config.toml}"

# The keybinding block to insert (only when the binding is absent).
KEYBINDING_BLOCK='[[keys.command]]
key = "prefix+l"
command = "herdr plugin action invoke worklog-selection-list.open-worklist"
description = "Open the Worklog work item selection pane in a new tab."'

# ── 1. Link the plugin (no-op when already linked) ──────────────────────
if command -v herdr >/dev/null 2>&1; then
  if herdr plugin link "${REPO_ROOT}/packages/herdr/herdr-plugin.toml"; then
    echo "Linked herdr plugin: worklog-selection-list"
  else
    echo "Warning: 'herdr plugin link' failed (plugin may already be linked, or herdr is busy)." >&2
  fi
else
  echo "Warning: 'herdr' not found on PATH — skipping plugin link (npm run build continues)." >&2
fi

# ── 2. Insert the keybinding (idempotent) ───────────────────────────────
if grep -qF 'worklog-selection-list.open-worklist' "${CONFIG_PATH}" 2>/dev/null; then
  echo "herdr keybinding already present: ${CONFIG_PATH}"
  exit 0
fi

if ! mkdir -p "$(dirname "${CONFIG_PATH}")"; then
  echo "Warning: cannot create herdr config directory '$(dirname "${CONFIG_PATH}")' — skipping keybinding insert." >&2
  exit 0
fi

# Append a leading newline when the existing file does not end with one,
# so the block always starts on its own line. No other edits are made.
if [[ -s "${CONFIG_PATH}" ]] && [[ "$(tail -c 1 "${CONFIG_PATH}"; printf x)" != $'\n'x ]]; then
  printf '\n' >> "${CONFIG_PATH}" || {
    echo "Warning: cannot write herdr config '${CONFIG_PATH}' — skipping keybinding insert." >&2
    exit 0
  }
fi

if ! printf '%s\n' "${KEYBINDING_BLOCK}" >> "${CONFIG_PATH}"; then
  echo "Warning: cannot write herdr config '${CONFIG_PATH}' — skipping keybinding insert." >&2
  exit 0
fi

echo "Inserted herdr keybinding (prefix+l -> worklog-selection-list.open-worklist) into ${CONFIG_PATH}"
