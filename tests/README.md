# Worklog Test Suite

This directory contains comprehensive tests for the Worklog project using [Vitest](https://vitest.dev/).

## Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (auto-rerun on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run TUI tests only (CI/headless)
npm run test:tui

# Generate per-test timings
```bash
# You can generate a JSON report of per-test timings which helps
# identify slow tests to refactor or move to integration-only runs.
# Run the timings collector (writes test-timings.json at repo root)
npm run test:timings

# Open test-timings.json for the slowest tests and candidates to move
cat test-timings.json | jq '.rows | sort_by(-.durationMs) | .[0:20]'
```

## Test Organization

Tests are spread across two top-level directories:

- **`tests/`** — the main test directory (this folder)
- **`test/`** — additional tests (migrations, TUI integration, doctor checks, etc.)

### Core unit tests (`tests/`)

- **`database.test.ts`** — WorklogDatabase CRUD, queries, comments, parent-child relationships
- **`jsonl.test.ts`** — JSONL import/export, backward compatibility, round-trip integrity
- **`sync.test.ts`** — Work item merging, field-level conflict resolution, tag/comment merging
- **`sync-worktree.test.ts`** — Git worktree sync scenarios
- **`config.test.ts`** — Configuration loading, defaults, validation, prefix management
- **`validator.test.ts`** — Work item field validation rules
- **`fts-search.test.ts`** — Full-text search across titles, descriptions, comments, tags
- **`sort-operations.test.ts`** — Sort index operations and rebalancing
- **`grouping.test.ts`** — Work item grouping logic
- **`file-lock.test.ts`** — File locking and concurrent access
- **`lockless-reads.test.ts`** — Lock-free read path correctness
- **`normalize-sqlite-bindings.test.ts`** — SQLite binding normalization
- **`plugin-loader.test.ts`** / **`plugin-integration.test.ts`** — Plugin discovery and loading
- **`github-*.test.ts`** — GitHub sync, push state, pre-filter, comments, deleted items, self-link, output

### CLI tests (`tests/cli/`)

- **`issue-management.test.ts`** — End-to-end create/update/delete/show workflows
- **`issue-status.test.ts`** — Status transitions
- **`status.test.ts`** — `wl status` command output
- **`team.test.ts`** — Team/sync CLI commands
- **`create-description-file.test.ts`** — `--description-file` flag
- **`init.test.ts`** — `wl init` workflow
- **`fresh-install.test.ts`** — Clean install scenario
- **`update-batch.test.ts`** — Batch update operations
- **`update-do-not-delegate.test.ts`** — Do-not-delegate flag handling
- **`reviewed.test.ts`** — `wl reviewed` toggle
- **`misc.test.ts`** — Miscellaneous CLI edge cases
- **`helpers-tree-rendering.test.ts`** — Tree display formatting
- **`action-opts-normalization.test.ts`** — Option normalization
- **`inproc-harness.test.ts`** / **`debug-inproc.test.ts`** — In-process test harness
- **`initialization-check.test.ts`** — Pre-init guard
- **`unlock.test.ts`** — Lock file removal
- **`git-mock-roundtrip.test.ts`** — Git mock for sync tests
- **`github-*.test.ts`** — GitHub push/filter CLI tests

### TUI tests (`tests/tui/`)

- **`tui-state.test.ts`** / **`state.test.ts`** — TUI state management
- **`controller.test.ts`** — TUI controller logic
- **`layout.test.ts`** — Layout rendering
- **`filter.test.ts`** — Item filtering
- **`move-mode.test.ts`** — Move/reparent mode
- **`autocomplete.test.ts`** / **`autocomplete-widget.test.ts`** — Autocomplete
- **`opencode-*.test.ts`** — OpenCode integration, SSE, prompt, sessions, layout
- **`persistence*.test.ts`** — TUI persistence
- **`focus-cycling-integration.test.ts`** — Focus cycling
- **`widget-create-destroy*.test.ts`** — Widget lifecycle
- **`status-stage-validation.test.ts`** — Status/stage rule enforcement in TUI
- **`tui-update-dialog.test.ts`** — Update dialog
- **`tui-mouse-guard.test.ts`** — Mouse event handling
- **`shutdown-flow.test.ts`** / **`event-cleanup.test.ts`** — Cleanup on exit
- **`next-dialog-wrap.test.ts`** — Next dialog wrapping
- **`toggle-do-not-delegate.test.ts`** — Do-not-delegate toggle in TUI

### Additional tests (`test/`)

- **`migrations.test.ts`** — Database migration tests
- **`doctor-dependency-check.test.ts`** / **`doctor-status-stage.test.ts`** — `wl doctor` checks
- **`comment-update.test.ts`** — Comment update operations
- **`validator.test.ts`** — Additional validation tests
- **`tui-integration.test.ts`** / **`tui-opencode-integration.test.ts`** — TUI integration
- **`tui-opencode-sse-handler.test.ts`** — OpenCode SSE handler
- **`tui-chords.test.ts`** — Keyboard chord handling
- **`tui-style.test.ts`** — TUI styling

## Test Coverage

Current test coverage: **894 tests passing, 0 skipped** across 82 test files.

## Test Utilities

The `test-utils.ts` file provides shared utilities for tests:

- `createTempDir()` - Creates a temporary directory for test isolation
- `cleanupTempDir(dir)` - Cleans up temporary directories after tests
- `createTempJsonlPath(dir)` - Generates a temp path for JSONL files
- `createTempDbPath(dir)` - Generates a temp path for database files
- `wait(ms)` - Async delay utility

## Writing New Tests

### Example Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir } from './test-utils.js';

describe('MyFeature', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    // Setup code
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should do something', () => {
    // Test code
    expect(result).toBe(expected);
  });
});
```

### Best Practices

1. **Isolate tests** - Each test should be independent and use temp directories
2. **Clean up** - Always clean up temp files and directories in `afterEach`
3. **Descriptive names** - Test names should clearly describe what is being tested
4. **Arrange-Act-Assert** - Structure tests with clear setup, execution, and verification phases
5. **Test edge cases** - Include tests for error conditions and boundary cases

## Continuous Integration

Tests run automatically on:
- Pull requests
- Pushes to main branch
- Manual workflow dispatch

## Known Issues

None at this time. All 894 tests pass with 0 skipped.

## Future Improvements

- Add API endpoint integration tests
- Increase code coverage measurement
- Add mutation testing
