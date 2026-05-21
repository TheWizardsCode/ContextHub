# Opencode-to-Pi Migration Guide

This guide documents the migration from the legacy OpenCode integration to the new Pi-based agent framework. It is intended for maintainers, reviewers, and anyone working on the TUI codebase.

## Overview

The TUI previously relied on an OpenCode client for agent interactions (natural language chat, action palette, and agent-driven flows). This has been replaced with the Pi framework, which provides:

- **PiAdapter** (`src/tui/pi-adapter.ts`): The core abstraction replacing `OpencodeClient`. Provides a clean interface for agent backend communication.
- **ChatPane** (`src/tui/chatPane.ts`): A natural language chat interface with keyword-based routing for `wl` commands (list, next, show, create, update, close, search, claim).
- **ActionPalette** (`src/tui/actionPalette.ts`): A keyboard-first action palette with default actions mapping to `wl` CLI commands.
- **wl CLI Integration** (`src/tui/wl-integration.ts`, `src/wl-integration/spawn.ts`): All work item reads/writes now go through the `wl` CLI via `child_process.spawn`, not direct database access.

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
- `src/tui/pi-adapter.ts` — new PiAdapter implementation
- `src/tui/chatPane.ts` — new ChatPane component
- `src/tui/actionPalette.ts` — new ActionPalette component
- `README.md` — added references to Pi agent features
- `docs/tutorials/04-using-the-tui.md` — updated tutorial with Pi agent chat and action palette

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

E2E tests for agent-driven flows are in `tests/e2e/agent-flow.test.ts`. They use mocked `child_process.spawn` for CI safety.

```bash
npx vitest run tests/e2e/agent-flow.test.ts
```

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

- [Pi TUI Design Checklist](./ux/design-checklist.md)
- [TUI.md](../TUI.md) — TUI controls and usage
- [wl CLI Integration API](./wl-integration-api.md)
- [Pi Adapter](../src/tui/pi-adapter.ts) — source code
