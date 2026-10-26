# Worklog Sync Module Layout

`src/sync.ts` is a thin public barrel; the implementation lives in focused
modules under `src/sync/`. The authoritative module map, the cycle-safe
layering and the "where to find X" pointer are in
[docs/ARCHITECTURE.md § Sync Module Layout](../ARCHITECTURE.md#sync-module-layout)
(WL-0MVGKGMU400631VZ / WL-0MVP9SEJZ000KWXJ).

## Quick reference

- **Public surface:** import from `src/sync.js` only. The 34 exported symbols
  (25 value + 9 type) are frozen in `tests/sync/sync.split-baseline.json`.
- **Internal modules:** `src/sync/*.ts` — do not import the barrel from inside
  `src/sync/`; import `./types.js`, `./git-exec.js`, etc. directly.
- **Structural gates:** `tests/sync/split-guard.test.ts` enforces the public
  surface, the ≤ 1,000-line ceiling (no exemptions) and an acyclic import
  graph.

See [docs/ARCHITECTURE.md](../ARCHITECTURE.md#sync-module-layout) for the full
module responsibility table and layering diagram.
