# Feature Request: OpenBrain Playwright Fallback Retrieval

**Work item:** OB-0MNHT5HTC0070EL7 *(OpenBrain project; tracked in this repo as GitHub issue #5)*  
**Stage:** intake_complete  
**Prepared by:** SourceBase (Discord bot integration layer)  
**Handoff target:** OpenBrain PM / Engineering

---

## Problem Statement

Some web pages render their primary content with client-side JavaScript. The current OpenBrain
retrieval path (fast HTML extraction) fails to return usable content for these pages, causing
`ob add <url>` to ingest an empty or near-empty document. A fallback that uses a headless browser
(Playwright) is needed so OpenBrain can ingest JavaScript-heavy pages reliably when the primary
extractor returns insufficient content.

---

## Users and User Stories

### Discord community operators
> As a community operator, when someone posts a JS-heavy article in our Discord I want the link
> ingested by OpenBrain so the knowledge is searchable — without needing to manually pre-render
> the page.

### Automation authors / operators running `ob add`
> As an automation author I want a configurable opt-in fallback so I can control the additional
> resource cost and CI behaviour that a headless browser introduces.

### OpenBrain engineers implementing the fallback
> As an engineer I need a clear set of technical acceptance criteria and test strategies so I can
> implement Playwright retrieval safely and verify it in CI without requiring a real browser on
> every run.

---

## Technical Acceptance Criteria

1. **PlaywrightExtractor class** — A new extractor (e.g. `src/lib/ingestion/extractor-playwright.ts`)
   implements the same interface as the existing extractor so it can be swapped in without changes
   to the ingestion pipeline (see `src/lib/ingestion/service.ts` and `src/lib/ingestion/extractor.ts`).

2. **Opt-in configuration flag** — Playwright fallback is disabled by default. It is enabled via an
   explicit configuration flag (e.g. `ingestion.playwrightFallback: true` in the OpenBrain config
   file or `OB_PLAYWRIGHT_FALLBACK=1` environment variable). Running `ob add` without the flag must
   not launch a browser process.

3. **Trigger condition** — The fallback fires only when the primary extractor returns a document
   whose extracted-text length is below a configurable threshold (e.g. `minContentLength: 200`
   characters). The threshold must be configurable and default to a value determined during
   implementation.

4. **Content compatibility** — The HTML/text produced by PlaywrightExtractor must be parseable by
   the same downstream ingestion pipeline that processes output from the existing extractor (entry
   point: `src/cli/commands/add.ts`). No structural changes to the ingestion pipeline are required.

5. **Graceful degradation** — If Playwright is not installed or fails to launch, the ingestion run
   logs a warning and completes with whatever content the primary extractor returned (empty or
   partial), rather than throwing an unhandled error.

6. **No credential leakage** — The Playwright session must not persist cookies, local storage, or
   auth tokens between runs. Each retrieval uses a fresh browser context.

7. **Timeout** — Browser navigation has an explicit timeout (default: 30 s, configurable). A
   timeout is treated the same as a Playwright launch failure (warn + continue).

8. **Telemetry emitted** — On every fallback invocation the implementation emits a structured log
   entry (see Telemetry section).

---

## CI / Testing Strategy

### Guiding principle
Playwright introduces a real browser runtime that is impractical on every public CI run. The
testing strategy separates fast unit tests (always run) from integration tests (opt-in or
gated).

### Record / playback fixtures (recommended default)
1. Record a set of HTTP interaction fixtures (e.g. using Playwright's network interception or a
   companion HTTP mock server such as `msw` / `nock`) covering:
   - A JS-heavy page that the primary extractor would return empty content for.
   - A page that the primary extractor handles correctly (fallback must not fire).
   - A page that returns a Playwright navigation timeout.
   - A page behind a redirect chain.
2. Store fixtures in `test/fixtures/playwright-fallback/`.
3. Unit / integration tests use the fixtures; real browser is never launched in public CI.

### Mock / stub option (minimal)
An alternative for projects that cannot store HTTP fixtures: stub `PlaywrightExtractor.fetch(url)`
at the module boundary and assert on:
- The correct call sequencing (primary extractor first, then fallback).
- The telemetry payload emitted.
- Graceful-degradation paths (install error, timeout).

### Full integration test (opt-in)
Gate behind an environment variable `OB_PLAYWRIGHT_INTEGRATION=1`. When set:
- Actually launch a Chromium browser.
- Fetch one real JS-heavy URL (or a local dev server that serves a SPA).
- Assert that ingested content is non-empty and passes the minimum-length threshold.

Suggested CI gate: run only on `main` branch pushes or nightly schedules; never on pull request
CI from forks to avoid resource/cost issues.

### Self-hosted runner consideration
Full integration tests should target a self-hosted runner with Chromium pre-installed, or use the
`microsoft/playwright` Docker image. Document the runner label requirement in the GitHub Actions
workflow file.

### Existing test reference
See the YouTube ingestion fallback (OB-0MNFXR3E4005TGYX) for a prior example of provider-specific
fallback tests and diagnostics.

---

## Telemetry / Diagnostics Requirements

Every Playwright fallback invocation must emit a structured log entry. Telemetry must be
non-sensitive: record only metadata, never user content, URLs, or secrets.

Suggested fields:

| Field | Type | Description |
|---|---|---|
| `event` | string | Fixed value `"playwright_fallback"` |
| `triggered` | boolean | Whether the fallback actually ran (false = threshold not met) |
| `primaryContentLength` | number | Character count returned by primary extractor |
| `fallbackContentLength` | number | Character count returned by PlaywrightExtractor (0 if not run or failed) |
| `durationMs` | number | Wall-clock time of the Playwright fetch in milliseconds |
| `success` | boolean | Whether PlaywrightExtractor returned usable content |
| `errorType` | string \| null | One of: `"launch_failed"`, `"timeout"`, `"navigation_error"`, `null` |
| `provider` | string | Always `"playwright"` for this fallback |

Log destination: existing OpenBrain diagnostics / structured logger. Do not write telemetry to a
remote endpoint; keep it local and opt-in to ship to any external service.

---

## Implementation Sketch

```
src/lib/ingestion/
├── extractor.ts           (existing — primary extractor, no changes required)
├── extractor-playwright.ts (new — PlaywrightExtractor, same interface)
└── service.ts             (existing — add fallback orchestration logic)

src/cli/commands/add.ts    (existing — passes through unchanged)
```

Suggested orchestration in `service.ts`:

```typescript
const primaryResult = await primaryExtractor.extract(url);
if (
  config.playwrightFallback &&
  primaryResult.text.length < config.minContentLength
) {
  const fallbackResult = await playwrightExtractor.extract(url);
  emitTelemetry({ triggered: true, ...metrics });
  return fallbackResult.text.length > 0 ? fallbackResult : primaryResult;
}
emitTelemetry({ triggered: false, primaryContentLength: primaryResult.text.length });
return primaryResult;
```

The above is illustrative. Exact method signatures must match the extractor interface defined in
`src/lib/ingestion/extractor.ts`.

### Dependency management
Add `playwright` (or `@playwright/test`) as an optional peer dependency so users who do not
enable the fallback do not need to install it. Guard the `require`/`import` behind a runtime
check to avoid import errors when the package is absent.

---

## Related Work and Code Pointers

Implementers should review the following before starting:

| Reference | Relevance |
|---|---|
| OB-0MN9HWGAL001452N — Ingest CLI: file and URL ingestion | Primary ingestion flow. Playwright output must be compatible with this pipeline. |
| OB-0MNFXR3E4005TGYX — Fix YouTube ingestion for ob add | Prior provider-specific fallback: tests, diagnostics, and error handling patterns to reuse. |
| OB-0MN9CZ48N0053L9Q — Create a full PRD for OpenBrain | Product-level guidance: local-first preferences and documented fallback policies. |
| `src/cli/commands/add.ts` | CLI entry point for `ob add`; Playwright output must be usable here. |
| `src/lib/ingestion/service.ts` | Ingestion orchestration; fallback logic belongs here. |
| `src/lib/ingestion/extractor.ts` | Extractor interface that PlaywrightExtractor must implement. |

---

## Constraints

- **Scope boundary:** Implementation belongs in the OpenBrain repo. SourceBase (this repository)
  is the Discord bot integration layer and produced this document only.
- **Opt-in only:** Playwright must never run unless explicitly enabled; do not change default
  behaviour of `ob add`.
- **No secrets in telemetry:** Telemetry fields must not include URL content, page text, cookies,
  auth tokens, or any user-identifiable data.
- **Optional dependency:** Playwright is a heavy runtime dependency. Declare it as optional/peer
  so existing installs are not forced to download browser binaries.
- **Record/playback for public CI:** Real browser launches must be gated; fixture-based tests must
  be the default.

---

## Open Questions

1. Should the minimum-content-length threshold be per-domain (allow-list) or global? Global is
   simpler; per-domain gives more control.
2. Which Playwright browser channel should be the default (`chromium`, `firefox`, `webkit`)?
   Recommend `chromium` for widest compatibility, but make it configurable.
3. Should the fallback be retried on timeout, or fail immediately? Recommend fail-immediately on
   first timeout to keep latency predictable.
4. Is there an existing structured-log / telemetry abstraction in OpenBrain to hook into, or does
   the engineer need to introduce one?

---

## Acceptance Checklist (for PM / Engineering reviewers)

- [ ] Feature request document reviewed and approved
- [ ] Child work items created in OpenBrain: PlaywrightExtractor, CI test harness, telemetry
- [ ] Configuration flag name agreed (e.g. `ingestion.playwrightFallback`)
- [ ] Extractor interface reviewed; PlaywrightExtractor signature confirmed
- [ ] Record/playback fixture strategy confirmed or alternative agreed
- [ ] Self-hosted runner label and CI gate condition documented
- [ ] Optional-dependency approach confirmed (peer dep vs. dynamic import guard)
- [ ] Telemetry field list reviewed; privacy sign-off obtained
