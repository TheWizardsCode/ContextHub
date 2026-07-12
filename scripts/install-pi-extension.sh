#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXTENSION_SOURCE_DIR="${REPO_ROOT}/packages/tui/extensions"
TARGET_DIR="${PI_GLOBAL_EXTENSIONS_DIR:-${HOME}/.pi/agent/extensions}"
TARGET_LINK="${TARGET_DIR}/worklog"

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
