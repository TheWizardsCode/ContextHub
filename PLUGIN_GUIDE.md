# Worklog Plugin System

## Overview

Worklog supports a pluggable command architecture that allows you to extend the CLI with custom commands without modifying the Worklog codebase. Plugins are compiled ESM modules (.js or .mjs files) that register new commands at runtime.

## Quick Start

### 1. Create a Plugin Directory

By default, Worklog looks for plugins in `.worklog/plugins/` relative to your current working directory:

```bash
mkdir -p .worklog/plugins
```

### 2. Write a Simple Plugin

Create a file `.worklog/plugins/hello.mjs`:

```javascript
// Type imports are optional for JavaScript plugins, but recommended for IDE autocomplete
// import type { PluginContext } from 'worklog/src/plugin-types';

export default function register(ctx) {
  ctx.program
    .command('hello')
    .description('Say hello')
    .option('-n, --name <name>', 'Name to greet', 'World')
    .action((options) => {
      if (ctx.utils.isJsonMode()) {
        ctx.output.json({ 
          success: true, 
          message: `Hello, ${options.name}!` 
        });
      } else {
        console.log(`Hello, ${options.name}!`);
      }
    });
}
```

### 3. Use Your Plugin

```bash
worklog hello
# Output: Hello, World!

worklog hello --name Alice
# Output: Hello, Alice!

worklog hello --json
# Output: {"success":true,"message":"Hello, World!"}
```

## Plugin API

### Plugin Module Structure

Every plugin must be an ESM module with a default export that is a registration function.

**For TypeScript plugins:**

```typescript
import type { PluginContext } from 'worklog/src/plugin-types';

export default function register(ctx: PluginContext): void {
  // Register your commands here
}
```

**For JavaScript plugins:**

The type import is optional (only needed if you're developing in TypeScript or want IDE autocomplete). JavaScript plugins work without any imports:

```javascript
export default function register(ctx) {
  // Register your commands here
}
```

**Note:** If developing plugins in a separate repository without Worklog source, you can:
- Copy `src/plugin-types.ts` from Worklog for type definitions, or
- Skip type imports entirely for plain JavaScript plugins (types are for development-time only)

### Plugin Context

The `PluginContext` object passed to your registration function contains:

#### `ctx.program`
The Commander.js `Command` instance. Use this to register your commands:

```javascript
ctx.program
  .command('my-command')
  .description('My custom command')
  .option('-f, --flag', 'A flag')
  .action((options) => {
    // Command implementation
  });
```

#### `ctx.output`
Output helpers that respect the `--json` flag:

```javascript
// Output JSON (when --json is set) or plain text
ctx.output.success('Operation completed', { data: 'value' });
ctx.output.error('Operation failed', { error: 'details' });

// Always output JSON
ctx.output.json({ custom: 'data' });
```

#### `ctx.utils`
Utility functions for common operations:

```javascript
// Check if Worklog is initialized (exits if not)
ctx.utils.requireInitialized();

// Get database instance
const db = ctx.utils.getDatabase();
const items = db.getAll();

// Get configuration
const config = ctx.utils.getConfig();

// Get prefix (respects --prefix override)
const prefix = ctx.utils.getPrefix(options.prefix);

// Check if in JSON output mode
if (ctx.utils.isJsonMode()) {
  // Output JSON
}
```

#### `ctx.version`
Current Worklog version string.

#### `ctx.dataPath`
Default data file path.

### Database Access

Plugins can access the Worklog database to read or modify work items:

```javascript
export default function register(ctx) {
  ctx.program
    .command('my-stats')
    .description('Show custom statistics')
    .action(() => {
      ctx.utils.requireInitialized();
      const db = ctx.utils.getDatabase();
      
      const items = db.getAll();
      const openItems = items.filter(i => i.status === 'open');
      const criticalItems = items.filter(i => i.priority === 'critical');
      
      ctx.output.json({
        success: true,
        total: items.length,
        open: openItems.length,
        critical: criticalItems.length
      });
    });
}
```

## Plugin Development

### Development Workflow

**Note:** This section shows how to develop a plugin in a separate project/repository. You can organize your plugin project however you prefer - `my-plugin/` is just an example structure.

1. **Write Your Plugin in TypeScript (Optional)**

   Create your plugin source (e.g., `my-plugin/src/index.ts`):
   ```typescript
   import type { PluginContext } from 'worklog/src/plugin-types';
   
   export default function register(ctx: PluginContext): void {
     ctx.program
       .command('my-cmd')
       .description('My command')
       .action(() => {
         console.log('Hello from my plugin!');
       });
   }
   ```
   
   **Folder structure suggestion:**
   ```
   my-plugin/
   ├── src/
   │   └── index.ts      # Your plugin source
   ├── dist/             # Compiled output (generated)
   │   └── index.js
   ├── package.json
   └── tsconfig.json
   ```

2. **Set Up TypeScript Compilation**

   Create `my-plugin/package.json`:
   ```json
   {
     "name": "my-worklog-plugin",
     "version": "1.0.0",
     "type": "module",
     "scripts": {
       "build": "tsc"
     },
     "devDependencies": {
       "typescript": "^5.3.3"
     }
   }
   ```

   Create `my-plugin/tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "ES2022",
       "moduleResolution": "node",
       "outDir": "./dist",
       "esModuleInterop": true
     }
   }
   ```

3. **Compile and Install**

   ```bash
   cd my-plugin
   npm install
   npm run build
   
   # Copy compiled plugin to Worklog plugin directory
   cp dist/index.js ~/.worklog/plugins/my-plugin.js
   ```

4. **Test Your Plugin**

   ```bash
   worklog --help    # Should show your command
   worklog my-cmd    # Run your command
   ```
   
   **Note on command grouping:** Plugin commands appear in the "Other" group in `--help` output by default. Only built-in commands are organized into specific groups (Issue Management, Status, Team).

### Plugin Best Practices

#### 1. Always Check Initialization

**Note:** The `requireInitialized()` check ensures Worklog is properly configured before your command runs. While you could check initialization in the CLI bootstrap, doing it in each command action provides better error messages and is the recommended pattern for plugin consistency.

```javascript
ctx.program
  .command('my-cmd')
  .action((options) => {
    // Fail early if Worklog not initialized
    ctx.utils.requireInitialized();
    
    // Your command logic
  });
```

#### 2. Support JSON Output Mode

```javascript
const result = performOperation();

if (ctx.utils.isJsonMode()) {
  ctx.output.json({ success: true, result });
} else {
  console.log(`Result: ${result}`);
}
```

#### 3. Handle Errors Gracefully

```javascript
try {
  const result = riskyOperation();
  ctx.output.success('Operation completed', { result });
} catch (error) {
  ctx.output.error(`Operation failed: ${error.message}`, { 
    success: false, 
    error: error.message 
  });
  process.exit(1);
}
```

#### 4. Respect Prefix Overrides

```javascript
.option('--prefix <prefix>', 'Override the default prefix')
.action((options) => {
  const db = ctx.utils.getDatabase(options.prefix);
  // ...
});
```

#### 5. Use Verbose Logging for Debugging

When your plugin performs complex operations, add verbose logging to help users debug issues. Check the global `--verbose` flag through the program options:

```javascript
export default function register(ctx) {
  ctx.program
    .command('my-cmd')
    .action((options) => {
      const isVerbose = ctx.program.opts().verbose;
      
      if (isVerbose) {
        console.log('Starting operation...');
      }
      
      // Your command logic
      
      if (isVerbose) {
        console.log('Operation completed successfully');
      }
    });
}
```

Users can then run `worklog --verbose my-cmd` to see detailed output for troubleshooting.

### Handling Dependencies

Plugins are copied into the target project's `.worklog/plugins/` directory, where Node.js resolves imports relative to that location — **not** relative to the Worklog binary. This means any `import` of an npm package (e.g., `import chalk from 'chalk'`) will fail unless that package is installed in the target project's `node_modules`.

To avoid runtime failures, follow one of the strategies below.

#### Self-Contained Plugins (Recommended)

Write plugins with zero external runtime imports. For example, instead of importing `chalk` for colored output, use built-in ANSI escape codes:

```javascript
const supportsColor = typeof process !== 'undefined'
  && process.stdout
  && (process.stdout.isTTY || process.env.FORCE_COLOR);

const wrap = (open, close) => supportsColor
  ? (str) => `\x1b[${open}m${str}\x1b[${close}m`
  : (str) => str;

const ansi = {
  red:           wrap('31', '39'),
  green:         wrap('32', '39'),
  blue:          wrap('34', '39'),
  cyan:          wrap('36', '39'),
  gray:          wrap('90', '39'),
  yellowBright:  wrap('93', '39'),
  // ... add more as needed
};
```

This is the approach used by the built-in `stats-plugin.mjs`.

#### Bundling Dependencies

Use a bundler such as [esbuild](https://esbuild.github.io/) or [rollup](https://rollupjs.org/) to produce a single-file plugin with all dependencies inlined:

```bash
esbuild src/my-plugin.ts --bundle --format=esm --outfile=dist/my-plugin.mjs
cp dist/my-plugin.mjs .worklog/plugins/
```

#### Graceful Import Failure

If you want to use an external package when available but degrade gracefully when it is not, use a dynamic `import()` wrapped in a try/catch:

```javascript
let chalk;
try {
  chalk = (await import('chalk')).default;
} catch {
  // Provide no-op fallbacks when chalk is unavailable
  chalk = new Proxy({}, { get: () => (str) => str });
}
```

This approach keeps the plugin functional regardless of the host project's dependencies.

## Configuration

### Plugin Directory

Worklog discovers plugins from two directories, checked in priority order:

1. **Project-local:** `.worklog/plugins/` in the current working directory (highest priority)
2. **Global:** `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/.worklog/plugins/`

When the same plugin filename exists in both directories, the project-local version takes precedence and the global copy is silently skipped.

The `$WORKLOG_PLUGIN_DIR` environment variable overrides **both** directories — only the single path it specifies is scanned:

```bash
export WORKLOG_PLUGIN_DIR=/path/to/my/plugins
worklog --help  # Loads only from the specified directory
```

### Supported File Extensions

- `.js` - JavaScript ES modules
- `.mjs` - JavaScript ES modules (explicit)

**Not supported:**
- `.d.ts` - TypeScript declaration files (ignored)
- `.map` - Source maps (ignored)
- `.cjs` - CommonJS modules (not supported)

### Load Order

Plugins are loaded in deterministic lexicographic order by filename:

- `a-first.mjs` - loads first
- `m-middle.js` - loads second
- `z-last.mjs` - loads last

## Troubleshooting

### List Discovered Plugins

```bash
worklog plugins

# With verbose output
worklog plugins --verbose

# JSON output
worklog plugins --json
```

### Enable Verbose Logging

```bash
worklog --verbose --help
# Shows plugin load diagnostics
```

### Common Issues

#### Plugin Not Found

**Problem:** `worklog --help` doesn't show your command.

**Solutions:**
- Verify plugin file exists in `.worklog/plugins/`
- Check file extension is `.js` or `.mjs`
- Run `worklog plugins` to see discovered plugins
- Check `WORKLOG_PLUGIN_DIR` environment variable

#### Module Resolution Errors

**Problem:** `Cannot find module 'xyz'` or `Cannot find package 'xyz'` error.

**Solutions:**
- Make your plugin self-contained with no external imports (see [Handling Dependencies](#handling-dependencies))
- Use a bundler (esbuild, rollup) to create a single-file plugin
- Check that you're exporting as ESM (`export default`)

#### Syntax Errors

**Problem:** `SyntaxError: Unexpected token` error.

**Solutions:**
- Verify your plugin is valid ES2022 JavaScript
- Compile TypeScript to JavaScript before installing
- Check for missing semicolons, braces, etc.

#### Plugin Fails to Load

**Problem:** Plugin loads but command doesn't work.

**Solutions:**
- Verify `default export` is a function
- Ensure registration function calls `ctx.program.command()`
- Check for runtime errors in your action handler
- Run with `--verbose` to see error details

## Example Plugins

The `examples/` directory contains complete, working plugin examples:

### [stats-plugin.mjs](examples/stats-plugin.mjs)
Shows custom work item statistics with database access, JSON mode support, and formatted output. This plugin is fully self-contained with no external dependencies (uses built-in ANSI escape codes for colored output).
Note: running `wl init` will automatically install `examples/stats-plugin.mjs` into your project's `.worklog/plugins/` directory if it is not already present.

### [bulk-tag-plugin.mjs](examples/bulk-tag-plugin.mjs)
Demonstrates bulk operations - adding tags to multiple work items filtered by status.

### [export-csv-plugin.mjs](examples/export-csv-plugin.mjs)
Exports work items to CSV format with proper escaping and file system operations.

For more details and installation instructions, see [examples/README.md](examples/README.md).

## Security Considerations

### Important Security Notes

⚠️ **Plugins execute arbitrary code with the same permissions as Worklog.**

- Only install plugins from trusted sources
- Review plugin code before installation
- Plugins can read/write all work items in your database
- Plugins can access your file system
- Plugins can make network requests

### Recommended Practices

1. **Code Review:** Always review plugin source code before installing
2. **Sandboxing:** Consider running Worklog in a container or VM when using third-party plugins
3. **Minimal Permissions:** Run Worklog with minimal user permissions
4. **Version Control:** Track installed plugins in your version control
5. **Disable if Needed:** Remove plugin files from `.worklog/plugins/` to disable them

### Disabling Plugin Loading

If you want to disable plugin loading entirely:

```bash
# Set plugin directory to non-existent path
export WORKLOG_PLUGIN_DIR=/dev/null

# Or remove/rename the plugin directory
mv .worklog/plugins .worklog/plugins.disabled
```

## Advanced Topics

### Async Operations

Plugins can use async/await:

```javascript
export default async function register(ctx) {
  // Async setup if needed
  
  ctx.program
    .command('fetch-external')
    .description('Fetch data from external API')
    .action(async () => {
      ctx.utils.requireInitialized();
      
      try {
        const response = await fetch('https://api.example.com/data');
        const data = await response.json();
        
        ctx.output.json({ success: true, data });
      } catch (error) {
        ctx.output.error(`Failed: ${error.message}`);
        process.exit(1);
      }
    });
}
```

### Subcommand Groups

Create command groups like the built-in `comment` command:

```javascript
export default function register(ctx) {
  const reportGroup = ctx.program
    .command('report')
    .description('Generate reports');
  
  reportGroup
    .command('daily')
    .description('Generate daily report')
    .action(() => {
      // Daily report logic
    });
  
  reportGroup
    .command('weekly')
    .description('Generate weekly report')
    .action(() => {
      // Weekly report logic
    });
}
```

### Access to Built-in Helpers

If you need access to built-in formatters or utilities, you can import them directly:

```javascript
// Note: Requires worklog to be installed as a dependency
import { humanFormatWorkItem } from 'worklog/dist/commands/helpers.js';

export default function register(ctx) {
  ctx.program
    .command('pretty-list')
    .description('List items with custom formatting')
    .action(() => {
      const db = ctx.utils.getDatabase();
      const items = db.getAll();
      
      items.forEach(item => {
        console.log(humanFormatWorkItem(item, db, 'normal'));
      });
    });
}
```

## FAQ

### Q: Can I use npm packages in my plugin?

**A:** Yes, but you need to bundle them into your plugin file. Use a bundler like esbuild or rollup to create a single-file bundle with all dependencies included. Alternatively, you can make your plugin self-contained by replacing external dependencies with built-in equivalents (see [Handling Dependencies](#handling-dependencies)).

### Q: Can plugins modify existing commands?

**A:** No, plugins can only add new commands. They cannot modify or remove built-in commands. If a plugin tries to register a command name that already exists, it will fail to load.

### Q: Do plugins persist across Worklog updates?

**A:** Yes, plugins in `.worklog/plugins/` are not affected by Worklog updates. However, the plugin API may change between major versions, so test your plugins after upgrading.

### Q: Can I distribute plugins via npm?

**A:** Yes! Publish your compiled plugin as an npm package and users can install it:

```bash
npm install -g my-worklog-plugin
cp $(npm root -g)/my-worklog-plugin/dist/plugin.js ~/.worklog/plugins/
```

### Q: How do I debug my plugin?

**A:** Add `console.log()` statements and run with `--verbose`:

```bash
worklog --verbose my-command
```

You can also use Node.js debugging:

```bash
node --inspect-brk $(which worklog) my-command
```
