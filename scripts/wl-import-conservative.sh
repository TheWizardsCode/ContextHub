#!/usr/bin/env bash
# Run wl github import with conservative throttler environment variables
# Usage: ./scripts/wl-import-conservative.sh [--yes]
# By default runs wl github import in dry-run mode if wl supports such flag; otherwise runs normally.

set -euo pipefail

# Conservative defaults to avoid GitHub secondary rate-limits during large imports
: "Using conservative GitHub throttling settings for this import"
export WL_GITHUB_RATE=${WL_GITHUB_RATE:-1}
export WL_GITHUB_BURST=${WL_GITHUB_BURST:-2}
export WL_GITHUB_CONCURRENCY=${WL_GITHUB_CONCURRENCY:-2}

echo "Running wl github import with conservative throttling settings:"
echo "  WL_GITHUB_RATE=$WL_GITHUB_RATE"
echo "  WL_GITHUB_BURST=$WL_GITHUB_BURST"
echo "  WL_GITHUB_CONCURRENCY=$WL_GITHUB_CONCURRENCY"

echo "Starting import... (press Ctrl-C to abort)"

# Run the import command. If you want a non-interactive run, pass --yes to skip prompts.
if [ "${1:-}" = "--yes" ]; then
  wl github import --yes
else
  wl github import
fi

EXIT_CODE=$?

echo "wl github import finished with exit code: $EXIT_CODE"
exit $EXIT_CODE
