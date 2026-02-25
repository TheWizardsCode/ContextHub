# Worklog Plugin Examples

This directory contains example plugins that demonstrate how to extend Worklog with custom commands.

## Available Examples

### stats-plugin.mjs

A comprehensive example showing database access, JSON output mode support, initialization checking, error handling, and statistics calculation.

**Features:**
- Shows total work items
- Breaks down items by status and priority
- Counts items with parents, tags, and comments
- Supports both human-readable and JSON output

**Installation:**

```bash
cp examples/stats-plugin.mjs .worklog/plugins/
worklog stats
```

Note: running `wl init` will automatically install `examples/stats-plugin.mjs` into your project's `.worklog/plugins/` directory if it is not already present.

### bulk-tag-plugin.mjs

Demonstrates bulk operations - adding tags to multiple work items filtered by status.

**Installation:**

```bash
cp examples/bulk-tag-plugin.mjs .worklog/plugins/
worklog bulk-tag -t feature -s open
```

### export-csv-plugin.mjs

Exports work items to CSV format with proper escaping and file system operations.

**Installation:**

```bash
cp examples/export-csv-plugin.mjs .worklog/plugins/
worklog export-csv -f output.csv
```

## Quick Start

1. **Copy an example plugin:**
   ```bash
   cp examples/stats-plugin.mjs .worklog/plugins/
   ```

2. **Verify it appears:**
   ```bash
   worklog --help  # Should show your command
   worklog plugins # Lists discovered plugins
   ```

3. **Test the command:**
   ```bash
   worklog stats
   worklog stats --json
   ```

## Creating Your Own Plugins

For complete documentation on creating custom plugins, see the [Plugin Development Guide](../PLUGIN_GUIDE.md), which includes:
- Plugin API reference with TypeScript signatures
- Development workflow (TypeScript → ESM compilation)
- Best practices and patterns
- Troubleshooting guide
- Security considerations
