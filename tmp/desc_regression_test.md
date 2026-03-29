# Summary
Add automated tests that verify expand/collapse latency stays under 200 ms after any code change.

## Acceptance Criteria
- Test suite runs on CI and fails if latency exceeds the threshold.
- Test results are visible in the CI pipeline summary.

## Minimal Implementation
- Reuse the benchmark harness as a test case (`npm run test:perf`).
- Add a CI step in `.github/workflows/ci.yml` to run the performance test on every push.
