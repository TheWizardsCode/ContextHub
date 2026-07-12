#!/usr/bin/env bash
# Helper script to run tests in a serial fashion for CI environments
set -euo pipefail

echo "Running vitest with single worker"
# Vitest doesn't accept --runInBand; using NODE_OPTIONS to limit workers can help in some environments
VITEST_WORKER_THREADS=1 npx vitest run "$@"
