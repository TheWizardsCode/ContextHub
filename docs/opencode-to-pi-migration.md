# Opencode-to-Pi Migration Guide

This guide documents the migration from the legacy OpenCode integration to the Pi-based agent framework. It is intended for maintainers, reviewers, and anyone working on the codebase.

> **Note:** The Pi-based TUI (chat pane, action palette, `/wl` browse flow)
> has since been removed from the repository — work item browsing and
> management is now provided by the [Herdr plugin](../packages/herdr/). The
> agent-side Pi extension modules (activity indicator, session health, model
> display, guardrails, skill-path tool, error recovery, lease release)
> remain and auto-load into every pi session.

## Overview

The TUI previously relied on an OpenCode client for agent interactions (natural language chat, action palette, and agent-driven flows). This was replaced with the Pi framework, which provides:

- **wl CLI Integration** (`packages/tui/extensions/wl-integration.ts`, `src/wl-integration/spawn.ts`): All work item reads/writes go through the `wl` CLI via `child_process.spawn`, not direct database access.

## What Changed

### Files Removed

- `docs/opencode-tui.md` — legacy OpenCode TUI documentation
- `tests/tui/opencode-triple-keypress.repro.test.ts` — reproduction test for OpenCode textarea bug
- `test/tui-opencode-integration.test.ts` — OpenCode integration test suite
- `.opencode/` — local OpenCode development directory and its dependencies
- `dist/opencode-*` — compiled OpenCode artifacts (cleaned on rebuild)

### Files Renamed

- `opencode-client.ts` → `pi-adapter.ts`
- `opencode-autocomplete.ts` → `command-autocomplete.ts`
- `opencode-sse.ts` → removed (replaced with Pi event handling)
- `opencode-pane.ts` → removed (replaced with ChatPane)

### Files Modified

- `src/tui/controller.ts` — replaced `OpencodeClient` with `PiAdapter`, updated key handlers
- `src/tui/constants.ts` — updated key descriptions and references
- `packages/tui/extensions/index.ts` (Pi extension) — new PiAdapter implementation
- `packages/tui/extensions/Worklog/chatPane.ts` — new ChatPane component (removed in the Pi TUI removal)
- `packages/tui/extensions/Worklog/actionPalette.ts` — new ActionPalette component (removed in the Pi TUI removal)
- `README.md` — added references to Pi agent features
- `docs/tutorials/04-using-the-tui.md` — updated tutorial with Pi agent chat and action palette (removed in the Pi TUI removal)

### Files Retained (for reference)

- `test/tui-integration.test.ts` — still references old dialog labels; needs review
- `src/pi-audit.ts` — contains comments referencing opencode audit; uses `wl` CLI now

## Migration Steps for Contributors

### 1. Replacing OpenCode imports

**Before:**
```typescript
import { OpencodeClient } from './opencode-client.js';
```

**After:**
```typescript
import { PiAdapter } from './pi-adapter.js';
```

### 2. Replacing OpenCode client calls

**Before:**
```typescript
const client = new OpencodeClient(port);
client.startServer();
const response = await client.sendPrompt(message);
```

**After:**
```typescript
const adapter = new PiAdapter();
await adapter.initialize();
const response = await adapter.sendMessage(message);
```

### 3. Accessing work items

**Before (direct DB access):**
```typescript
const items = db.list({ status: 'open' });
const item = db.get(id);
db.update(id, { status: 'in-progress' });
```

**After (wl CLI):**
```typescript
import { runWl } from './wl-integration.js';

const items = await runWl('list', ['--status', 'open']);
const item = await runWl('show', [id]);
await runWl('update', [id, '--status', 'in-progress']);
```

### 4. Key bindings

The `O` key opens the agent chat pane (was "Open OpenCode prompt"). The `A` key runs the Pi audit (was "Run audit via OpenCode").

## Testing

### Running the test suite

```bash
npm test
```

All 157+ tests should pass. Tests that previously depended on `OpencodeClient` have been migrated to use `PiAdapter` mocks or `runWl` wrappers.

### E2E tests

E2E tests for agent-driven flows lived in `tests/e2e/agent-flow.test.ts` (mocked
`child_process.spawn` for CI safety). That file, together with
`tests/e2e/headless-tui.test.ts`, was removed when the Pi-based TUI was
removed — work item browsing moved to the Herdr plugin (`packages/herdr/`).

## FAQ

### Q: Why remove OpenCode entirely?

A: The Pi framework provides a more robust, extensible, and well-documented agent integration. It eliminates the dependency on a separate OpenCode server process and simplifies the TUI architecture.

### Q: Can I still use OpenCode?

A: No. The OpenCode integration has been fully replaced. If you have specific workflows that relied on OpenCode features, please file a feature request to add them via the Pi framework.

### Q: The old "Run opencode" dialog label is still in test mocks.

A: Yes. The test file `test/tui-integration.test.ts` still references the old dialog labels. These tests may need updating to reflect the new Pi agent labels.

### Q: Where is the Pi agent backend configured?

A: The PiAdapter uses the standard Pi framework configuration. Check the Pi documentation for agent configuration options.

## Related Documentation

- [wl CLI Integration API](./wl-integration-api.md)
- [Herdr plugin](../packages/herdr/) — work item browsing and management
- [Pi extension README](../packages/tui/extensions/README.md) — retained agent-side plugin modules
