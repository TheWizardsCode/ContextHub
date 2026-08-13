#!/usr/bin/env bash
# install-herdr.sh — idempotent Herdr integration installer for Worklog
#
# Links the `worklog-selection-list` Herdr plugin and registers the
# `prefix+l` keybinding in the Herdr config, so the worklist works out of
# the box after `npm run build` (invoked via the root `postbuild` hook).
#
# Safe to run on every build:
#   - The plugin is always linked from the MAIN checkout, even when the
#     build runs inside a linked git worktree (WL-0MSRG481O007QVEA):
#     linking from a worktree leaves a dangling registry entry once the
#     worktree is deleted, silently breaking the prefix+l keybinding.
#     `herdr plugin link` updates an existing link in place, so a stale
#     worktree link is corrected automatically on the next build.
#   - The keybinding block is inserted only when a binding for
#     `worklog-selection-list.open-podcast-editor-tab` is not already present.
#   - A legacy `open-worklist` prefix+l binding is migrated in-place to the
#     new open-podcast-editor-tab action (never duplicates the key).
#   - Missing herdr binary or an unwritable config only warn (exit 0), so
#     `npm run build` never fails in CI/offline environments.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Main-checkout resolution (worktree-safe) ────────────────────────────
# During /skill:implement the postbuild hook runs from a linked git
# worktree, so REPO_ROOT would resolve to the worktree path. Linking the
# global herdr plugin from a worktree leaves a dangling registry entry once
# implement.py finish deletes the worktree — the prefix+l keybinding then
# invokes a non-existent action and silently does nothing. Resolve the main
# checkout (always listed first by `git worktree list --porcelain`) and
# link from there instead. Falls back to REPO_ROOT when not inside a git
# repo or git is unavailable.
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  MAIN_CHECKOUT="$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"
  if [ -n "${MAIN_CHECKOUT}" ] && [ -d "${MAIN_CHECKOUT}" ]; then
    REPO_ROOT="${MAIN_CHECKOUT}"
  fi
fi

MANIFEST_PATH="${REPO_ROOT}/packages/herdr/herdr-plugin.toml"

# Config resolution matches herdr itself: HERDR_CONFIG_PATH overrides,
# otherwise ~/.config/herdr/config.toml.
CONFIG_PATH="${HERDR_CONFIG_PATH:-${HOME}/.config/herdr/config.toml}"

# The keybinding block to insert (only when the binding is absent).
KEYBINDING_BLOCK='[[keys.command]]
key = "prefix+l"
command = "herdr plugin action invoke worklog-selection-list.open-podcast-editor-tab"
description = "Open the Podcast Editing tab (Worklog work item selection pane)."'

# Legacy binding command (v0.1.x) that prefix+l previously pointed at.
# Migrated in-place to the new action so re-running a build never leaves
# a stale duplicate keybinding.
LEGACY_BINDING='herdr plugin action invoke worklog-selection-list.open-worklist'
NEW_BINDING='herdr plugin action invoke worklog-selection-list.open-podcast-editor-tab'

# ── 1. Link the plugin (updates an existing link in place) ───────────────
if command -v herdr >/dev/null 2>&1; then
  if herdr plugin link "${MANIFEST_PATH}"; then
    echo "Linked herdr plugin: worklog-selection-list (${MANIFEST_PATH})"
  else
    echo "Warning: 'herdr plugin link' failed (plugin may already be linked, or herdr is busy)." >&2
  fi
else
  echo "Warning: 'herdr' not found on PATH — skipping plugin link (npm run build continues)." >&2
fi

# ── 2. Insert/replace the keybinding (idempotent) ──────────────────────
if grep -qF "${NEW_BINDING}" "${CONFIG_PATH}" 2>/dev/null; then
  echo "herdr keybinding already present: ${CONFIG_PATH}"
  exit 0
fi

# Migrate a legacy prefix+l binding (open-worklist) to the new action so
# the podcast editing tab name takes effect without a manual config edit.
if grep -qF "${LEGACY_BINDING}" "${CONFIG_PATH}" 2>/dev/null; then
  if python3 - "${CONFIG_PATH}" <<'PY'
import sys
path = sys.argv[1]
with open(path) as f:
    text = f.read()
new = "herdr plugin action invoke worklog-selection-list.open-podcast-editor-tab"
old = "herdr plugin action invoke worklog-selection-list.open-worklist"
if old in text:
    with open(path, "w") as f:
        f.write(text.replace(old, new))
PY
  then
    echo "Migrated herdr keybinding (prefix+l -> worklog-selection-list.open-podcast-editor-tab) in ${CONFIG_PATH}"
    exit 0
  else
    echo "Warning: cannot migrate herdr config '${CONFIG_PATH}' — skipping keybinding update." >&2
    exit 0
  fi
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

echo "Inserted herdr keybinding (prefix+l -> worklog-selection-list.open-podcast-editor-tab) into ${CONFIG_PATH}"
