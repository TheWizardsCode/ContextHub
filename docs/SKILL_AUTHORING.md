# Skill Authoring Guide

> Best practices for creating pi agent skills with well-structured directories,
> correct script referencing, and testable workflows.

## Table of Contents

- [Overview](#overview)
- [Directory Structure](#directory-structure)
- [SKILL.md Conventions](#skillmd-conventions)
- [Script Referencing Patterns](#script-referencing-patterns)
- [Script Invocation](#script-invocation)
- [Error Handling](#error-handling)
- [Testing Scripts](#testing-scripts)
- [Testing Checklist](#testing-checklist)
- [Common Pitfalls](#common-pitfalls)
- [Resources](#resources)

## Overview

A pi skill is a self-contained capability package loaded on-demand by the
agent. Every skill follows the [Agent Skills standard](https://agentskills.io/specification)
and consists of a `SKILL.md` file with optional helper scripts, reference
documentation, and static assets.

**Key principle:** The agent reads `SKILL.md` and follows its instructions,
using relative paths to reference scripts and assets within the skill
directory. Path resolution starts from the skill's own directory, not the
agent's working directory.

## Directory Structure

The canonical skill layout:

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts (executable)
│   ├── process.sh
│   ├── helper.py
│   └── validate.py
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
├── assets/               # Static resources
│   └── template.json
└── resources/            # Templates, schemas, test fixtures
    └── test-failure-template.md
```

### Directory roles

| Directory | Purpose |
|-----------|---------|
| `scripts/` | Executable scripts invoked by the agent. Keep these focused and well-documented. |
| `references/` | Supporting documentation loaded on-demand (e.g., detailed API guides). |
| `assets/` | Static resources consumed by scripts (templates, configs, icons). |
| `resources/` | Templates or schemas used by scripts (synonym for `assets/`; use consistently). |

### Rules

- **`SKILL.md` is required** at the root of the skill directory. Everything
  else is optional.
- **Name the skill directory** with a lowercase, hyphen-separated name that
  matches the skill's purpose (e.g., `code-review`, `brave-search`,
  `effort-and-risk`).
- **Keep `SKILL.md` concise.** Use `references/` for detailed documentation
  that the agent loads on-demand.
- **Do not place scripts in the skill root.** Always use a `scripts/`
  subdirectory to keep the root clean.
- **Scripts must be executable.** Set the executable bit: `chmod +x scripts/*.sh`.

## SKILL.md Conventions

### Frontmatter

Every `SKILL.md` must start with frontmatter per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

```yaml
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase a-z, 0-9, hyphens. Max 64 chars. |
| `description` | Yes | Max 1024 chars. Be specific about when to use. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Environment requirements (max 500 chars). |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. |

**Name rules:**
- 1–64 characters
- Lowercase letters, numbers, hyphens only
- No leading or trailing hyphens
- No consecutive hyphens

✅ Good: `code-review`, `pdf-processing`, `data-analysis-v2`
❌ Bad: `Code-Review`, `-my-skill`, `my--skill`

**Description best practices:**

✅ Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

❌ Poor:
```yaml
description: Helps with PDFs.
```

### Usage Section

Always include a `## Usage` or `## How to Use` section that shows the agent
how to run the skill's scripts:

```markdown
## Usage

```bash
cd ~/.pi/agent/skills/my-skill
./scripts/process.sh <input>
```
```

### Scripts Section

Explicitly list all available scripts and their purposes:

```markdown
## Scripts

- `./scripts/process.sh` — Main processing script. Takes one argument.
- `./scripts/validate.py` — Validates input before processing.
- `./scripts/cleanup.sh` — Removes temporary files.
```

### References Section

Link to reference documentation that the agent may need to load:

```markdown
## References

- [API Reference](references/api-reference.md)
- [Configuration Guide](references/configuration.md)
```

## Script Referencing Patterns

### Recommended: Relative paths with `cd`

Use relative paths from the skill directory and instruct the agent to `cd` first:

```markdown
## Usage

```bash
# Navigate to the skill directory first
cd ~/.pi/agent/skills/my-skill

# Then run scripts using relative paths
./scripts/process.sh <input>
```
```

**Why this is recommended:**
- Paths are short and readable
- Works regardless of the agent's working directory
- Matches pi's documented convention
- Scripts can reference their own `./scripts/` and `./assets/` without
  absolute path assumptions

### Alternative: Full absolute paths

When the skill directory must be referenced directly:

```markdown
## Usage

```bash
python3 ~/.pi/agent/skills/my-skill/scripts/helper.py --flag value
```
```

**Use this when:**
- The script needs to be invoked from a different working directory
- The command is part of a pipeline that must run in a specific directory

### Cross-Skill References

When one skill needs to reference a script in another skill:

```markdown
## References

- Owner inference: `../owner_inference/scripts/infer_owner.py`
- Triage template: `../triage/resources/test-failure-template.md`
```

Always use `../<target-skill>/` relative to the current skill's location.

### What NOT to do

| ❌ Incorrect pattern | Reason |
|----------------------|--------|
| `skill/my-skill/scripts/process.sh` | Uses deprecated `skill/` prefix. |
| `/home/user/.pi/agent/skills/my-skill/scripts/process.sh` | Hardcoded absolute path breaks on other machines. |
| `./scripts/process.sh` without `cd` instruction | Agent may be in wrong working directory. |
| `scripts/process.sh` (no `./` prefix) | Less explicit; `./` clearly indicates relative path. |

## Script Invocation

### Finding the Skill Directory

Agents can locate the skill directory using these conventions:

```bash
# For globally installed skills (most common)
SKILL_DIR=~/.pi/agent/skills/my-skill

# For project-local skills (e.g., in a repository)
SKILL_DIR=.pi/skills/my-skill

# When the skill is in a custom location
SKILL_DIR=$(dirname "$(readlink -f "$0")")  # From within the script itself
```

### Running Scripts

**Option 1: `cd` first (recommended)**

```bash
cd ~/.pi/agent/skills/my-skill
./scripts/process.sh <input>
```

**Option 2: Full path with variable**

```bash
SKILL_DIR=~/.pi/agent/skills/my-skill
python3 "$SKILL_DIR/scripts/helper.py" --flag value
```

**Option 3: Direct path (for simple cases)**

```bash
~/.pi/agent/skills/my-skill/scripts/process.sh <input>
```

### Passing Arguments and Pipelines

When scripts accept piped input or complex arguments, show examples:

```bash
# Piped input
cat data.txt | cd ~/.pi/agent/skills/my-skill && ./scripts/process.sh

# With flags
cd ~/.pi/agent/skills/my-skill && ./scripts/process.sh --input file.txt --verbose

# JSON output for agent consumption
cd ~/.pi/agent/skills/my-skill && ./scripts/process.sh --json --input data.txt
```

### JSON Output Convention

When implementing scripts that agents consume programmatically, always
support a `--json` flag for structured output:

```bash
cd ~/.pi/agent/skills/my-skill && ./scripts/process.sh --json
```

This allows agents to parse results without regex-based text scraping.

## Error Handling

### When a Script Is Not Found

Document what agents should do:

```markdown
## Error Handling

If a script is not found:
1. Check that the skill is installed: `pi list`
2. Verify the script path in `SKILL.md` matches the actual file location
3. Ensure the script is executable: `ls -la scripts/`
4. If the problem persists, report the issue to the skill maintainer
```

### Script Exit Codes

Document expected exit codes:

```markdown
## Exit Codes

- `0` — Success
- `1` — General error (check stderr for details)
- `2` — Invalid arguments
- `3` — Missing dependencies
```

### Error Recovery

Provide guidance for common failures:

```markdown
## Troubleshooting

### "Command not found"
Ensure the script is executable:
```bash
chmod +x ~/.pi/agent/skills/my-skill/scripts/*.sh
```

### "Permission denied"
The script may need execute permissions:
```bash
chmod +x ~/.pi/agent/skills/my-skill/scripts/*.sh
```

### "Module not found" (Python)
Install dependencies:
```bash
cd ~/.pi/agent/skills/my-skill && pip install -r requirements.txt
```

### "No such file or directory"
The script references a relative path that doesn't exist. Check that:
- You are in the correct skill directory
- All referenced files exist relative to the script's location
```

## Testing Scripts

### Local Testing

Before publishing a skill, test all scripts from the skill directory:

```bash
cd ~/.pi/agent/skills/my-skill

# Test with --help
./scripts/process.sh --help

# Test with sample input
./scripts/process.sh test-input

# Test with JSON output
./scripts/process.sh --json --input test-data.json

# Test error handling
./scripts/process.sh  # Should show usage or error
```

### Integration Testing

Create a test file to validate your skill end-to-end. For a TypeScript/Node.js
project, use a test framework like Vitest:

```typescript
// tests/skills/my-skill.test.ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const SKILL_DIR = path.resolve(process.env.HOME || '', '.pi/agent/skills/my-skill');

describe('my-skill', () => {
  it('should print help and exit 0', () => {
    const result = execSync(
      `cd "${SKILL_DIR}" && ./scripts/process.sh --help`,
      { encoding: 'utf-8' }
    );
    expect(result).toContain('Usage');
  });

  it('should process input and produce output', () => {
    const result = execSync(
      `cd "${SKILL_DIR}" && echo "test data" | ./scripts/process.sh`,
      { encoding: 'utf-8' }
    );
    expect(result).toBeTruthy();
  });

  it('should output valid JSON with --json flag', () => {
    const result = execSync(
      `cd "${SKILL_DIR}" && ./scripts/process.sh --json --input "test"`,
      { encoding: 'utf-8' }
    );
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should exit non-zero with invalid input', () => {
    expect(() => {
      execSync(
        `cd "${SKILL_DIR}" && ./scripts/process.sh --invalid-flag`,
        { encoding: 'utf-8' }
      );
    }).toThrow();
  });
});
```

### Validation Scripts

When your skill ships with a validation script, reference it in the
`SKILL.md` so agents can run it:

```markdown
## Validation

Run the validation script to check that all references are correct:

```bash
cd ~/.pi/agent/skills/my-skill
./scripts/validate.py
```
```

### Testing Cross-Skill References

For skills that reference other skills, tests should verify that cross-skill
paths resolve correctly:

```typescript
it('should resolve cross-skill paths correctly', () => {
  // Test that ../target-skill/scripts/foo.py exists
  const crossRef = path.join(SKILL_DIR, '../target-skill/scripts/helper.py');
  expect(fs.existsSync(crossRef)).toBe(true);
});
```

## Testing Checklist

Use this checklist when creating or updating a skill:

- [ ] **Frontmatter is valid**: `name` and `description` are present and follow naming rules.
- [ ] **Scripts are executable**: `chmod +x scripts/*.sh` has been run.
- [ ] **Relative paths are used**: No hardcoded absolute paths in `SKILL.md`.
- [ ] **`./` prefix is used**: Scripts referenced as `./scripts/foo.py`, not `scripts/foo.py`.
- [ ] **No legacy `skill/<name>/` references**: The deprecated pattern is not used.
- [ ] **Cross-skill references use `../<target>/`**: Correct relative path to sibling skills.
- [ ] **`cd` instruction is present**: Agents know to navigate to the skill directory first.
- [ ] **Scripts support `--help`**: Users and agents can discover usage interactively.
- [ ] **Scripts support `--json`**: Agents can consume structured output programmatically.
- [ ] **Exit codes are documented**: Expected exit codes are listed in `SKILL.md`.
- [ ] **Dependencies are documented**: Any required packages, runtimes, or setup steps.
- [ ] **Tests exist**: At least one test file validates the skill's behavior.
- [ ] **Error handling is documented**: Common failures and recovery steps.
- [ ] **`references/` is populated**: Supporting docs exist for complex skills.
- [ ] **Scripts pass linting**: Shell scripts pass `shellcheck`, Python passes `ruff`, etc.

## Common Pitfalls

### 1. Legacy `skill/<name>/` Paths

Old-style paths start with `skill/`:

```markdown
❌ Deprecated:
../skill/my-skill/scripts/process.sh
skill/triage/scripts/check.py

✅ Correct:
./scripts/process.sh
../triage/scripts/check.py
```

### 2. Missing `cd` Instructions

Without explicit `cd` instructions, the agent may run scripts from the wrong
directory:

```markdown
❌ Agents may be in wrong directory:
./scripts/process.sh

✅ Navigate first:
cd ~/.pi/agent/skills/my-skill
./scripts/process.sh
```

### 3. Hardcoded Absolute Paths

Paths that contain a specific username or machine location:

```markdown
❌ Breaks on other machines:
/home/alice/.pi/agent/skills/my-skill/scripts/process.sh

✅ Uses relative paths:
cd ~/.pi/agent/skills/my-skill && ./scripts/process.sh
```

### 4. Forgetting to Set the Executable Bit

Scripts that aren't executable cause "Permission denied" errors:

```bash
# Always do this:
chmod +x scripts/*.sh
```

### 5. No JSON Output Support

Agents consume structured data more reliably than text:

```markdown
❌ Agents must parse human-readable text:
./scripts/process.sh input.txt
# Output: "Processed 5 items in 2.3s"

✅ Agents can consume structured output:
./scripts/process.sh --json --input input.txt
# Output: {"processed": 5, "duration": 2.3, "errors": []}
```

### 6. Overly Vague Description

The description is the primary signal for when the agent loads the skill:

```markdown
❌ Too vague:
description: Helps with code reviews.

✅ Specific:
description: Reviews code changes for correctness, maintainability, and adherence to project standards. Use when preparing commits for review or during code review workflows.
```

### 7. Not Documenting Dependencies

Agents need to know what setup is required:

```markdown
## Setup

Run once before first use:

```bash
cd ~/.pi/agent/skills/my-skill
pip install -r requirements.txt
node --version  # Requires Node 18+
```
```

## Resources

- [Agent Skills Specification](https://agentskills.io/specification) — Official standard for skill frontmatter and structure.
- [pi Skills Documentation](https://github.com/badlogic/pi-coding-agent/blob/main/docs/skills.md) — Pi's skill loading and discovery (also available locally at `~/.pi/agent/docs/skills.md`).
- [Skill Path Conventions](./skill-path-conventions.md) — Standardized path referencing for pi skills (establishes `./scripts/` and `../target/` conventions).
- [Worklog AGENTS.md](../AGENTS.md) — AI agent workflow instructions and work-item tracking.
