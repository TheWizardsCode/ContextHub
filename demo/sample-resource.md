# Sample Work Item — CLI Markdown Rendering Demo

This file demonstrates how the CLI markdown renderer handles various
Markdown constructs when displaying work item content.

## Code Examples

Use the `wl show` command to view work items:

```bash
wl show WL-1234 --format markdown
wl show WL-1234 --format plain
wl show WL-1234 --format auto
```

## Inline Code

Run `wl status` to see a summary, or `wl next` for recommendations.

## Lists

- First item
- Second item with `code`
- Third item with a [link](http://example.com)

1. Ordered item one
2. Ordered item two

## Links

Learn more at [Worklog docs](http://example.com/docs) or the [GitHub repo](http://github.com/example/repo).

## Size Guard

The CLI renderer automatically falls back to plain text when content exceeds
the size limit (default 100 KB). This safeguards CI logs and prevents
truncated or garbled output in automation environments.

## Configuration

Set `cliFormatMarkdown: true` in `.worklog/config.yaml` to always enable
markdown rendering, or `false` to always disable it. The precedence is:

1. **CLI flag** `--format markdown|plain|text|auto` takes priority
2. **Config key** `cliFormatMarkdown: true|false` is checked next
3. **Auto-detect** based on TTY status is the default