#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXTENSION_SOURCE_DIR="${REPO_ROOT}/packages/tui/extensions"
TARGET_DIR="${PI_GLOBAL_EXTENSIONS_DIR:-${HOME}/.pi/agent/extensions}"
TARGET_LINK="${TARGET_DIR}/worklog"

# ---------- Guards (WL-0MUSTNEQW003V3KO) ----------
#
# These guards prevent the installer from mutating the global Pi extension
# symlink when it would be unsafe to do so (worktree context or unbuilt
# checkout).  They run *before* any mutation of ${TARGET_DIR}.

# Guard 1 — worktree context.
# If REPO_ROOT contains the worktree path segment created by
# `implement.py`, skip installation entirely.  This prevents the script
# from repointing the global extension at an unbuilt worktree directory
# that will be deleted once the implement session ends.
if [[ "${REPO_ROOT}" == *".worklog/worktrees/"* ]]; then
  echo "Skipping Pi extension install: REPO_ROOT is inside a worktree (${REPO_ROOT})." >&2
  echo "The global extension symlink is untouched — run from a built checkout instead."
  exit 0
fi

# Guard 2 — unbuilt checkout.
# The extension runtime loads compiled output from dist/ (wl-integration.ts
# requires dist/wl-integration/spawn.js via realpath-resolved
# createRequire()).  If this artefact is absent the installed extension will
# crash on use.  Advise the developer to run `npm run build` instead of
# silently installing a broken link.
SPAWN_JS="${REPO_ROOT}/dist/wl-integration/spawn.js"
if [[ ! -f "${SPAWN_JS}" ]]; then
  echo "Skipping Pi extension install: missing required dist output: dist/wl-integration/spawn.js" >&2
  echo "Run \`npm run build\` to compile, then retry \`npm run install:pi-extension\`."
  exit 0
fi

# ---------- Main install flow ----------

if [[ ! -d "${EXTENSION_SOURCE_DIR}" ]]; then
  echo "Extension source directory not found: ${EXTENSION_SOURCE_DIR}" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"

if [[ -L "${TARGET_LINK}" ]]; then
  rm -f "${TARGET_LINK}"
elif [[ -e "${TARGET_LINK}" ]]; then
  BACKUP_PATH="${TARGET_LINK}.bak.$(date +%Y%m%d%H%M%S)"
  mv "${TARGET_LINK}" "${BACKUP_PATH}"
  echo "Existing extension path moved to backup: ${BACKUP_PATH}"
fi

ln -s "${EXTENSION_SOURCE_DIR}" "${TARGET_LINK}"

echo "Linked Pi extension directory: ${TARGET_LINK} -> ${EXTENSION_SOURCE_DIR}"
echo "Start or restart pi and run /reload to load the extension."
