# Worklog Sync Module Layout

`src/sync.ts` is a thin public barrel; the implementation lives in focused
modules under `src/sync/`. The authoritative module map, the cycle-safe
layering and the "where to find X" pointer are in
[docs/ARCHITECTURE.md § Sync Module Layout](../ARCHITECTURE.md#sync-module-layout)
(WL-0MVGKGMU400631VZ / WL-0MVP9SEJZ000KWXJ).

## Quick reference

- **Public surface:** import from `src/sync.js` only. The 34 exported symbols
  (25 value + 9 type) are frozen in `tests/sync/sync.split-baseline.json`.
- **Identity guards (pull + push):** the pull-side gate
  (`checkAuthorIdentity`) and the push-side guard
  (`checkPushAuthorIdentity`/`enforcePushAuthorIdentity`, both in
  `src/sync/author-identity.ts`) are documented together in
  [docs/SYNC_IDENTITY_GATE.md](../SYNC_IDENTITY_GATE.md). The push guard
  refuses to *publish* worklog-data commits when the effective `user.email` is
  empty or an exact incident-era sentinel (`t@t.com` et al.); it is wired into
  `gitPushDataFileToBranch` and `rewriteAndForcePushDataFile`
  (WL-0MWGO58KL00187CO). Its extra decision exports live off the frozen barrel
  surface and are imported from the module path.
- **Internal modules:** `src/sync/*.ts` — do not import the barrel from inside
  `src/sync/`; import `./types.js`, `./git-exec.js`, etc. directly.
- **Structural gates:** `tests/sync/split-guard.test.ts` enforces the public
  surface, the ≤ 1,000-line ceiling (no exemptions) and an acyclic import
  graph.

See [docs/ARCHITECTURE.md](../ARCHITECTURE.md#sync-module-layout) for the full
module responsibility table and layering diagram.
