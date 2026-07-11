# GitHub throttling (TokenBucketThrottler)

This project uses a central client-side throttler to coordinate outgoing GitHub
API requests. The throttler implements a simple token-bucket with an optional
concurrency cap to make bulk syncs and CI-friendly automation less likely to
trigger GitHub secondary-rate-limits or abuse-detection behavior.

Runtime configuration

- WL_GITHUB_RATE — tokens per second (rate). Default: 6
- WL_GITHUB_BURST — bucket capacity (burst). Default: 12
- WL_GITHUB_CONCURRENCY — maximum concurrent scheduled tasks. Default: 6

Notes

- The defaults are conservative but reasonable for typical developer machines
  and CI runs. Tune these values for larger-scale automation (e.g. large
  org-wide syncs) or when running in CI with dedicated rate budgets.

- When WL_GITHUB_CONCURRENCY is unset the throttler will still enforce rate
  limits. Setting WL_GITHUB_CONCURRENCY explicitly allows lowering or raising
  parallelism independently of token refill semantics.

- All GitHub helper functions that perform network I/O should schedule their
  requests via `throttler.schedule(() => ...)` so callers do not need to
  coordinate or duplicate scheduling logic.

Examples

# Run a local bulk sync with reduced concurrency (useful for low-rate CI):

```sh
export WL_GITHUB_RATE=2
export WL_GITHUB_BURST=4
export WL_GITHUB_CONCURRENCY=2
wl github push
```

# Increase throughput when you have a high-rate CI worker:

```sh
export WL_GITHUB_RATE=20
export WL_GITHUB_BURST=40
export WL_GITHUB_CONCURRENCY=10
wl github push
```

Testing

- Unit tests may inject a fake clock or create a local throttler instance via
  `makeThrottlerFromEnv({ rate, burst, concurrency, clock })` to deterministically
  exercise refill, depletion, and concurrency semantics.

Implementation

See `src/github-throttler.ts` for the throttler implementation and `src/github.ts`
for example usage patterns. 