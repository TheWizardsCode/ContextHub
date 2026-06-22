# Skill Path Conventions

> Documents the standardised path referencing pattern for pi agent skills.
> Established per WL-0MQOIKGW2005BLZH.

## Convention

All skill `SKILL.md` files use **relative paths from the skill directory**,
as specified by the pi documentation (`docs/skills.md`):

> "The agent follows the instructions, using relative paths to reference scripts and assets."
> "Use relative paths from the skill directory."

### In-Skill References

When a `SKILL.md` references a script or asset within its own skill directory,
use `./` as the prefix:

```
./scripts/foo.py          # was: skill/<current>/scripts/foo.py
./assets/template.json    # was: skill/<current>/assets/template.json
./resources/doc.md        # was: skill/<current>/resources/doc.md
```

### Cross-Skill References

When a `SKILL.md` references a script or asset in another skill directory,
use `../<target-skill>/` as the prefix:

```
../triage/scripts/check_or_create.py    # was: skill/triage/scripts/check_or_create.py
../ship/scripts/ship.js                  # was: skill/ship/scripts/ship.js
../refactor/SKILL.md                     # was: skill/refactor/SKILL.md
```

### Invocation Convention

Agents should `cd` to the skill directory before running any script:

```bash
cd ~/.pi/agent/skills/<skill-name>
./scripts/foo.py <args>
```

This matches pi's documented pattern ("Use relative paths from the skill
directory") and ensures path resolution is predictable regardless of the
working directory the agent was in when the skill was loaded.

### AGENTS.md References

The global AGENTS.md at `~/.pi/agent/AGENTS.md` uses `skills/<name>/...`
prefixes since it lives one directory above the `skills/` directory:

```
resources/skills/ship/SKILL.md           # ~/.pi/agent/AGENTS.md → ~/.pi/agent/skills/ship/SKILL.md  
```

### Backward Compatibility

The old `skill/<name>/` pattern is deprecated but still supported (agents may
still resolve these paths by searching upward for a `skill/` directory). New
skills and documentation should use the relative-path conventions above.

## Testing

The test file `tests/skill-path-conventions.test.ts` validates that all
SKILL.md files in `~/.pi/agent/skills/` follow these conventions.

Run the tests:

```bash
npx vitest run tests/skill-path-conventions.test.ts
```
