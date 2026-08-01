#!/usr/bin/env python3
"""
Script to update all SKILL.md files in ~/.pi/agent/skills/ to use relative
path conventions as specified by pi's skill documentation.

Convention (from pi docs/skills.md):
  - "Use relative paths from the skill directory"
  - In-skill references: ./scripts/foo.py
  - Cross-skill references: ../<target>/scripts/foo.py

Usage:
  python3 scripts/update-skill-paths.py          # dry-run by default
  python3 scripts/update-skill-paths.py --apply   # actually apply changes
"""

import os
import re
import sys
from pathlib import Path

HOME = os.environ.get("HOME", "/home/rgardler")
SKILLS_DIR = Path(HOME) / ".pi" / "agent" / "skills"
AGENTS_MD = Path(HOME) / ".pi" / "agent" / "AGENTS.md"

# Pattern: match skill/<dir-name>/<rest-of-path>
# Where dir-name is alphanumeric with hyphens/underscores
# And rest-of-path is optional path components
SKILL_REF_PATTERN = re.compile(
    r'(skill/([a-zA-Z0-9_]+(?:-[a-zA-Z0-9_]+)*)(/[a-zA-Z0-9_.\-/]+)?)'
)


def get_skill_dirs() -> list[str]:
    """Get list of skill directory names that have SKILL.md."""
    if not SKILLS_DIR.exists():
        return []
    return sorted([
        e.name for e in SKILLS_DIR.iterdir()
        if e.is_dir() and (e / "SKILL.md").exists()
    ])


def get_all_subdirs() -> set[str]:
    """Get set of all subdirectory names under skills dir."""
    if not SKILLS_DIR.exists():
        return set()
    return {e.name for e in SKILLS_DIR.iterdir() if e.is_dir()}


def replace_skill_refs(content: str, skill_dir: str, all_dirs: set[str]) -> str:
    """
    Replace `skill/<name>/...` path references in the content.
    
    Rules:
    1. skill/<current>/... -> ./...
    2. skill/<other>/... -> ../<other>/...
    
    Skipped: references preceded by `./` or `../` (they are already relative paths
    in code examples, not bare skill path references).
    """
    def replacer(m: re.Match) -> str:
        full = m.group(1)   # e.g., "skill/audit/scripts/audit_runner.py"
        dir_name = m.group(2)  # e.g., "audit"
        rest = m.group(3)   # e.g., "/scripts/audit_runner.py"
        
        # Check if preceded by ./ or ../ (already a relative path in code examples).
        # The pattern could be `./skill/...`, `'./skill/...`, `"./skill/...`, etc.
        start = m.start()
        # Check if the character right before the match is '/' which means
        # we're inside a `./` or `../` path prefix
        if start > 0 and content[start - 1] == "/":
            return full
        
        if rest is None:
            rest = ""
        
        if dir_name == skill_dir:
            # In-skill reference -> ./
            result = "." + rest
        elif dir_name in all_dirs:
            # Cross-skill reference -> ../<dir>/<rest>
            result = f"../{dir_name}{rest}"
        else:
            # Not a known directory - could be a code word containing "skill/"
            # Leave as-is
            result = full
        
        return result
    
    return SKILL_REF_PATTERN.sub(replacer, content)


def update_skill_file(skill_dir: str, apply: bool = False) -> list[str]:
    """Update a single SKILL.md file. Returns list of changes."""
    filepath = SKILLS_DIR / skill_dir / "SKILL.md"
    content = filepath.read_text()
    all_dirs = get_all_subdirs()
    new_content = replace_skill_refs(content, skill_dir, all_dirs)
    
    changes = _compute_changes(content, new_content)
    
    if apply and changes:
        filepath.write_text(new_content)
        print(f"  WROTE: {filepath}")
    
    return changes


def update_agents_md(apply: bool = False) -> list[str]:
    """Update ~/.pi/agent/AGENTS.md. Returns list of changes."""
    content = AGENTS_MD.read_text()
    all_dirs = get_all_subdirs()
    
    # AGENTS.md is at ~/.pi/agent/AGENTS.md
    # Skills are at ~/.pi/agent/skills/<name>/
    # From AGENTS.md, skill/<name>/... -> skills/<name>/...
    
    def replacer(m: re.Match) -> str:
        full = m.group(1)
        dir_name = m.group(2)
        rest = m.group(3)
        
        if dir_name in all_dirs:
            if rest is None:
                rest = ""
            return f"skills/{dir_name}{rest}"
        return full
    
    new_content = SKILL_REF_PATTERN.sub(replacer, content)
    changes = _compute_changes(content, new_content)
    
    if apply and changes:
        AGENTS_MD.write_text(new_content)
        print(f"  WROTE: {AGENTS_MD}")
    
    return changes


def _compute_changes(old: str, new: str) -> list[str]:
    """Compute per-line changes between old and new content."""
    changes = []
    old_lines = old.split("\n")
    new_lines = new.split("\n")
    
    max_lines = max(len(old_lines), len(new_lines))
    for i in range(max_lines):
        old_line = old_lines[i] if i < len(old_lines) else ""
        new_line = new_lines[i] if i < len(new_lines) else ""
        if old_line != new_line:
            # Show only the changed portion for clarity
            changes.append(f"  L{i+1}: {_compact(old_line)}")
            changes.append(f"      -> {_compact(new_line)}")
    
    return changes


def _compact(s: str, max_len: int = 90) -> str:
    """Compact a line to max_len chars for display."""
    if len(s) > max_len:
        return s[:max_len - 3] + "..."
    return s


def main():
    apply = "--apply" in sys.argv
    action = "APPLYING" if apply else "DRY RUN"
    
    print(f"{'='*60}")
    print(f"  Skill Path Convention Update ({action})")
    print(f"{'='*60}\n")
    
    skills = get_skill_dirs()
    all_dirs = get_all_subdirs()
    print(f"Found {len(skills)} skills with SKILL.md, {len(all_dirs)} total dirs\n")
    
    total_changes = 0
    changed_files = 0
    
    for skill in skills:
        changes = update_skill_file(skill, apply=apply)
        if changes:
            total_changes += len(changes)
            changed_files += 1
            print(f"\n  {skill}/SKILL.md ({len(changes)} changes):")
            for c in changes:
                print(c)
    
    # Update AGENTS.md
    agents_changes = update_agents_md(apply=apply)
    if agents_changes:
        total_changes += len(agents_changes)
        changed_files += 1
        print(f"\n  AGENTS.md ({len(agents_changes)} changes):")
        for c in agents_changes:
            print(c)
    
    if total_changes == 0:
        print("  No changes needed!")
    
    print(f"\n{'='*60}")
    print(f"  Files changed: {changed_files}")
    print(f"  Total line changes: {total_changes}")
    print(f"  Mode: {action}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
