# Tutorial 3: Building a CLI Plugin

**Target audience:** Developers who want to extend Worklog with custom commands
**Time to complete:** 20-25 minutes
**Prerequisites:** Worklog installed ([Tutorial 1](01-your-first-work-item.md)), basic JavaScript knowledge

## What you will learn

By the end of this tutorial you will be able to:

- Create a Worklog plugin from scratch
- Use the PluginContext API to access work items
- Support JSON output mode for scripting
- Handle errors gracefully
- Test and debug your plugin

## How plugins work

Worklog plugins are ESM modules (`.js` or `.mjs` files) placed in `.worklog/plugins/`. Each plugin exports a default registration function that receives a `PluginContext` object. When Worklog starts, it discovers and loads all plugins in lexicographic order, and their commands appear alongside built-in commands.

## Step 1: Create the plugin directory

If you ran `wl init`, the directory already exists. Otherwise, create it:

```bash
mkdir -p .worklog/plugins
```

## Step 2: Write a minimal plugin

Create `.worklog/plugins/priority-report.mjs`:

```javascript
export default function register(ctx) {
  ctx.program
    .command('priority-report')
    .description('Show a summary of work items grouped by priority')
    .action(() => {
      ctx.utils.requireInitialized();

      const db = ctx.utils.getDatabase();
      const items = db.getAll();

      const groups = { critical: [], high: [], medium: [], low: [] };

      for (const item of items) {
        if (item.status !== 'completed' && item.status !== 'deleted') {
          const priority = item.priority || 'medium';
          if (groups[priority]) {
            groups[priority].push(item);
          }
        }
      }

      if (ctx.utils.isJsonMode()) {
        ctx.output.json({
          success: true,
          counts: {
            critical: groups.critical.length,
            high: groups.high.length,
            medium: groups.medium.length,
            low: groups.low.length,
          },
        });
      } else {
        console.log('Priority Report');
        console.log('===============');
        for (const [priority, list] of Object.entries(groups)) {
          console.log(`\n${priority.toUpperCase()} (${list.length}):`);
          for (const item of list) {
            console.log(`  ${item.id}: ${item.title}`);
          }
        }
      }
    });
}
```

## Step 3: Test your plugin

Verify Worklog discovers it:

```bash
wl plugins
```

Your plugin should appear in the list. Now run it:

```bash
wl priority-report
```

You should see work items grouped by priority. Try JSON mode:

```bash
wl priority-report --json
```

This outputs machine-readable JSON, useful for piping into other tools.

## Step 4: Add command options

Extend the command with a `--status` filter:

```javascript
export default function register(ctx) {
  ctx.program
    .command('priority-report')
    .description('Show a summary of work items grouped by priority')
    .option('-s, --status <status>', 'Filter by status (default: all open)')
    .action((options) => {
      ctx.utils.requireInitialized();

      const db = ctx.utils.getDatabase();
      let items = db.getAll();

      // Filter by status
      if (options.status) {
        items = items.filter(i => i.status === options.status);
      } else {
        items = items.filter(i =>
          i.status !== 'completed' && i.status !== 'deleted'
        );
      }

      const groups = { critical: [], high: [], medium: [], low: [] };
      for (const item of items) {
        const priority = item.priority || 'medium';
        if (groups[priority]) {
          groups[priority].push(item);
        }
      }

      if (ctx.utils.isJsonMode()) {
        ctx.output.json({
          success: true,
          filter: options.status || 'all open',
          counts: {
            critical: groups.critical.length,
            high: groups.high.length,
            medium: groups.medium.length,
            low: groups.low.length,
          },
        });
      } else {
        const filter = options.status || 'all open';
        console.log(`Priority Report (${filter})`);
        console.log('='.repeat(30));
        for (const [priority, list] of Object.entries(groups)) {
          console.log(`\n${priority.toUpperCase()} (${list.length}):`);
          for (const item of list) {
            console.log(`  ${item.id}: ${item.title}`);
          }
        }
      }
    });
}
```

Now you can filter:

```bash
wl priority-report --status in-progress
wl priority-report --status open --json
```

## Step 5: Handle errors

Wrap operations in try/catch to provide clear error messages:

```javascript
.action((options) => {
  try {
    ctx.utils.requireInitialized();
    const db = ctx.utils.getDatabase();
    // ... your logic
    ctx.output.success('Report generated', { /* data */ });
  } catch (error) {
    ctx.output.error(`Failed to generate report: ${error.message}`, {
      success: false,
      error: error.message,
    });
    process.exit(1);
  }
});
```

## Step 6: Add verbose logging

Use the global `--verbose` flag to help users debug issues:

```javascript
.action((options) => {
  const isVerbose = ctx.program.opts().verbose;

  ctx.utils.requireInitialized();
  const db = ctx.utils.getDatabase();
  const items = db.getAll();

  if (isVerbose) {
    console.log(`Loaded ${items.length} items from database`);
  }

  // ... rest of your logic

  if (isVerbose) {
    console.log('Report generation complete');
  }
});
```

Users run `wl --verbose priority-report` to see the debug output.

## Step 7: Create subcommand groups

For more complex plugins, organize commands into groups:

```javascript
export default function register(ctx) {
  const report = ctx.program
    .command('report')
    .description('Generate various reports');

  report
    .command('priority')
    .description('Group items by priority')
    .action(() => {
      // Priority report logic
    });

  report
    .command('assignee')
    .description('Group items by assignee')
    .action(() => {
      // Assignee report logic
    });
}
```

Usage:

```bash
wl report priority
wl report assignee
```

## Handling dependencies

Plugins run in the context of the target project, not the Worklog installation. Any `import` of an npm package resolves against the target project's `node_modules`. This means external packages like `chalk` will fail unless installed in the target project.

### Recommended: self-contained plugins

Write plugins with zero external imports. Use built-in APIs instead:

```javascript
// Instead of chalk, use ANSI escape codes
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const red = (s) => `\x1b[31m${s}\x1b[39m`;
const green = (s) => `\x1b[32m${s}\x1b[39m`;
```

### Alternative: bundle dependencies

Use esbuild to produce a single file with all dependencies inlined:

```bash
esbuild src/my-plugin.ts --bundle --format=esm --outfile=dist/my-plugin.mjs
cp dist/my-plugin.mjs .worklog/plugins/
```

## Testing your plugin

1. **Manual testing**: Run the command and verify output
2. **JSON mode testing**: Pipe `--json` output to `jq` for validation
3. **Verbose mode**: Use `--verbose` to trace execution
4. **Plugin discovery**: Run `wl plugins --verbose` to see load diagnostics

```bash
# Verify the plugin loads
wl plugins

# Test human output
wl priority-report

# Test JSON output
wl priority-report --json | jq '.counts'

# Test with verbose logging
wl --verbose priority-report
```

## Debugging common issues

| Problem | Solution |
|---------|----------|
| Command not showing in `wl --help` | Check file is in `.worklog/plugins/` with `.js` or `.mjs` extension |
| `Cannot find module` error | Make the plugin self-contained or bundle dependencies |
| `SyntaxError` on load | Ensure valid ES2022 syntax; compile TypeScript before installing |
| Command loads but fails | Add try/catch and run with `--verbose` for diagnostics |

## PluginContext API reference

| Property | Description |
|----------|-------------|
| `ctx.program` | Commander.js `Command` instance for registering commands |
| `ctx.output.json(data)` | Output JSON data |
| `ctx.output.success(msg, data)` | Output success message (respects `--json`) |
| `ctx.output.error(msg, data)` | Output error message (respects `--json`) |
| `ctx.utils.requireInitialized()` | Exit with error if Worklog is not initialized |
| `ctx.utils.getDatabase()` | Get the database instance |
| `ctx.utils.getConfig()` | Get the Worklog configuration |
| `ctx.utils.getPrefix(override?)` | Get the item ID prefix |
| `ctx.utils.isJsonMode()` | Check if `--json` flag is set |
| `ctx.version` | Current Worklog version string |
| `ctx.dataPath` | Default data file path |

## Summary

You built a complete Worklog plugin that:

- Registers a custom CLI command
- Reads work items from the database
- Supports `--json` output mode
- Accepts command-line options
- Handles errors gracefully
- Supports verbose logging

## Next steps

- [Using the TUI](04-using-the-tui.md) -- browse work items interactively
- [Plugin Guide](../../PLUGIN_GUIDE.md) -- full plugin API reference with advanced topics
- [Example Plugins](../../examples/README.md) -- working plugin examples (stats, bulk-tag, CSV export)
