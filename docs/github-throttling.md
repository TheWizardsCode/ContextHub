# GitHub API throttling configuration

This document describes environment variables that control the shared GitHub API throttler used by Worklog.

Location
- Implementation: src/github-throttler.ts
- Default shared instance: exported as `throttler` from src/github-throttler.ts

Environment variables

- WL_GITHUB_RATE
  - Meaning: Token refill rate (tokens per second). Each API call consumes one token.
  - Default: 2
  - Effect: Controls sustained request rate. Higher values allow more continuous throughput.
  - Example: `WL_GITHUB_RATE=5` allows an average of 5 requests per second.

- WL_GITHUB_BURST
  - Meaning: Bucket capacity (maximum number of tokens accumulated).
  - Default: 4
  - Effect: Allows short bursts above WL_GITHUB_RATE up to the burst size. A larger burst lets the system absorb short spikes in activity.
  - Example: `WL_GITHUB_BURST=10` permits short bursts of up to 10 immediate requests if tokens are available.

- WL_GITHUB_CONCURRENCY
  - Meaning: Global concurrency cap for concurrent GitHub API requests enforced by the central throttler.
  - Default: unset (no concurrency cap). When unset the throttler only enforces rate limits.
  - Notes: If you explicitly set the value to `0` or a negative number the throttler treats this as "unlimited" (Infinity). To disable the concurrency cap leave the variable unset.
  - Effect: When set to a positive integer the throttler will never run more than that many requests concurrently across the process.
  - Example: `WL_GITHUB_CONCURRENCY=4` limits concurrent GitHub API calls to 4.

- WL_GITHUB_THROTTLER_DEBUG
  - Meaning: Enable debug logging in the throttler implementation.
  - Default: unset/false
  - Example: `WL_GITHUB_THROTTLER_DEBUG=true`

Tuning guidance

- Start with conservative defaults
  - Defaults (rate=2, burst=4) are safe for small teams and avoid triggering GitHub abuse or secondary rate limits. Try increasing gradually.

- Increase WL_GITHUB_RATE for sustained throughput
  - If your usage is CPU/network-bound and GitHub's API rate limits permit it, increase `WL_GITHUB_RATE` to allow more sustained requests per second.
  - Keep `WL_GITHUB_BURST` modestly larger than `WL_GITHUB_RATE` so short spikes are absorbed without large bursts that could provoke abuse detection.

- Use WL_GITHUB_CONCURRENCY to limit parallelism
  - If the process launches many concurrent requests (e.g. large sync operations) set `WL_GITHUB_CONCURRENCY` to a value matching your acceptable parallelism (network capacity, token pool size, or pacing requirements).
  - Setting a concurrency cap can be safer than relying only on rate limiting if individual requests are slow or block other resources.

- Watch for GitHub rate limits and abuse responses
  - GitHub may throttle or return secondary rate-limit responses. If you see increased 403/429 or abuse-related responses, reduce rate/concurrency and increase monitoring. Use `WL_GITHUB_THROTTLER_DEBUG` during testing to inspect throttler behavior.

Migration notes

- Behaviour change when enabling WL_GITHUB_CONCURRENCY
  - Historically the code relied on local per-callsite concurrency controls. Once you set `WL_GITHUB_CONCURRENCY` a single global concurrency cap is enforced by the central throttler. Verify sync and CI workloads after enabling to ensure you don't unintentionally over-constrain throughput.

- Where to look in code
  - See src/github-throttler.ts for implementation details (TokenBucketThrottler and makeThrottlerFromEnv). The defaults are defined in that file:
    - rate default: 2
    - burst default: 4
    - concurrency default: Infinity (when WL_GITHUB_CONCURRENCY is unset)

- Recommended rollout
  1. Test changes in a development environment with `WL_GITHUB_THROTTLER_DEBUG=true`.
  2. Increase `WL_GITHUB_RATE` gradually and monitor API responses and CI job durations.
  3. If enabling `WL_GITHUB_CONCURRENCY` start with a permissive value (e.g. 10) and lower it if resource contention is observed.

Examples

- Conservative: use defaults (no changes)
  - no env vars set

- Moderate throughput with limited bursts and concurrency
  - WL_GITHUB_RATE=5
  - WL_GITHUB_BURST=8
  - WL_GITHUB_CONCURRENCY=6

- Debugging
  - WL_GITHUB_THROTTLER_DEBUG=true

Acceptance criteria

- This file documents WL_GITHUB_CONCURRENCY, WL_GITHUB_RATE and WL_GITHUB_BURST, lists defaults and provides tuning guidance, references src/github-throttler.ts, and provides migration notes.

If you'd like this added to the top-level README instead, or to a different docs page, tell me and I will move it there.