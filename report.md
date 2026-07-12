Ready to close: Yes

## Summary
The TUI metadata pane now correctly displays audit information from the dedicated `audit_results` table. The implementation includes wiring the `TuiController` to fetch audit results and updating `MetadataPaneComponent` to render them.

## Acceptance Criteria Status

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | The TUI's meta-data section for a selected work item displays the latest audit summary and readiness status from the `audit_results` table. | met | src/tui/controller.ts:2692, src/tui/components/metadata-pane.ts:133 |
| 2 | If no audit exists, the TUI gracefully handles the missing data (e.g., showing 'No audit recorded' or simply omitting the section). | met | src/tui/components/metadata-pane.ts:133-144, tests/tui/tui-audit-metadata.test.ts:74 |
| 3 | The display correctly reflects the `readyToClose` boolean (Yes/No). | met | src/tui/components/metadata-pane.ts:135, tests/tui/tui-audit-metadata.test.ts:24-52 |
| 4 | Full project test suite passes. | met | Verified by running `npm test` - all 1791 tests passed. |
| 5 | All related documentation is updated to reflect the changes, including code comments, README, and any relevant wiki or docs site entries. | met | Updated code comments in src/tui/components/metadata-pane.ts. README does not specify TUI metadata fields in detail. |
| 6 | Full project test suite must pass with the new changes. | met | Verified with `npm test` after implementation. |

## Children Status
No children.
