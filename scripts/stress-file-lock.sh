#!/usr/bin/env bash
# stress-file-lock.sh -- Run the parallel file-lock spawn test repeatedly
# to reproduce intermittent failures locally.
#
# Usage:
#   ./scripts/stress-file-lock.sh              # 50 iterations (default)
#   STRESS_ITERS=200 ./scripts/stress-file-lock.sh
#   WL_DEBUG=1 STRESS_ITERS=100 ./scripts/stress-file-lock.sh
#
# Environment variables:
#   STRESS_ITERS   Number of iterations to run (default: 50)
#   WL_DEBUG       Set to 1 to enable per-lock acquire/release debug logging
#
# Exit codes:
#   0  All iterations passed
#   1  At least one iteration failed (details in logs/)
#
# Logs are written to: stress-logs/  (relative to repo root)

set -euo pipefail

ITERS="${STRESS_ITERS:-50}"
LOG_DIR="stress-logs"
SUMMARY_FILE="${LOG_DIR}/summary.txt"

# Ensure we're running from the repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Create / clean log directory
rm -rf "${LOG_DIR}"
mkdir -p "${LOG_DIR}"

echo "=== file-lock stress harness ==="
echo "Iterations: ${ITERS}"
echo "WL_DEBUG:   ${WL_DEBUG:-0}"
echo "Logs dir:   ${LOG_DIR}/"
echo ""

PASS=0
FAIL=0
FAIL_RUNS=""

for i in $(seq 1 "${ITERS}"); do
  RUN_LOG="${LOG_DIR}/run-${i}.log"
  printf "Run %3d/%d ... " "${i}" "${ITERS}"

  if npx vitest run tests/file-lock.test.ts \
       -t "parallel spawn" \
       --reporter=verbose \
       > "${RUN_LOG}" 2>&1; then
    PASS=$((PASS + 1))
    printf "PASS"
  else
    FAIL=$((FAIL + 1))
    FAIL_RUNS="${FAIL_RUNS} ${i}"
    printf "FAIL  (see ${RUN_LOG})"
  fi

  # Extract and display the diagnostics line if present
  DIAG=$(grep -o '\[wl:file-lock:diagnostics\].*' "${RUN_LOG}" 2>/dev/null || true)
  if [ -n "${DIAG}" ]; then
    printf "  %s" "${DIAG}"
  fi

  # Extract anomaly lines if present
  ANOMALIES=$(grep '\[wl:file-lock:diag:anomaly\]' "${RUN_LOG}" 2>/dev/null || true)
  if [ -n "${ANOMALIES}" ]; then
    printf "\n    ANOMALIES:\n"
    echo "${ANOMALIES}" | sed 's/^/      /'
  fi

  printf "\n"
done

echo ""
echo "=== Summary ==="
echo "Total: ${ITERS}  Pass: ${PASS}  Fail: ${FAIL}"
if [ "${FAIL}" -gt 0 ]; then
  echo "Failed runs:${FAIL_RUNS}"
fi

# Write summary file
{
  echo "Iterations: ${ITERS}"
  echo "Pass: ${PASS}"
  echo "Fail: ${FAIL}"
  echo "Failed runs:${FAIL_RUNS}"
  echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "${SUMMARY_FILE}"

# Exit with failure if any run failed
if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "At least one run failed. Check ${LOG_DIR}/ for details."
  exit 1
else
  echo ""
  echo "All ${ITERS} runs passed."
  exit 0
fi
