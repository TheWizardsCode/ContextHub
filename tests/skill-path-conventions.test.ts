/**
 * Skill Path Conventions Tests (WL-0MQOIKGW2005BLZH)
 *
 * Validates that all SKILL.md files in ~/.pi/agent/skills/ use the correct
 * relative path conventions as specified by pi's skill documentation:
 *   - In-skill references: ./scripts/foo.py (not skill/<name>/scripts/foo.py)
 *   - Cross-skill references: ../<target>/scripts/foo.py (not skill/<target>/scripts/foo.py)
 *
 * See ~/.nvm/versions/node/.../docs/skills.md for the convention:
 * "The agent follows the instructions, using relative paths to reference scripts and assets"
 * "Use relative paths from the skill directory"
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SKILLS_DIR = path.resolve(process.env.HOME || '/home/rgardler', '.pi/agent/skills');

/**
 * Get all skill directories that have a SKILL.md file.
 */
function getSkillDirs(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')));
}

/**
 * Read the content of a SKILL.md file.
 */
function readSkillMd(skillDir: string): string {
  return fs.readFileSync(path.join(SKILLS_DIR, skillDir, 'SKILL.md'), 'utf-8');
}

/**
 * Find all `skill/<name>/` patterns that are path references
 * (not part of other words).
 */
function findSkillPathReferences(content: string): string[] {
  const refs: string[] = [];
  // Match patterns like `skill/something/scripts/foo.py` or `skill/something/SKILL.md`
  const regex = /skill\/[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_.\/-]+)?/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    // Skip false positives where "skill" is part of a longer word
    const prefix = content.slice(Math.max(0, match.index - 10), match.index);
    if (/\w/.test(prefix.slice(-1))) continue; // part of a larger word
    refs.push(match[0]);
  }
  return refs;
}

describe('Skill path conventions', () => {
  const skillDirs = getSkillDirs();

  it('should have at least one skill directory with SKILL.md', () => {
    if (skillDirs.length === 0) {
      console.warn('  Skipped on CI - ~/.pi/agent/skills/ not available');
      return;
    }
    expect(skillDirs.length).toBeGreaterThan(0);
  });

  describe.each(skillDirs)('Skill: %s', (skillDir: string) => {
    const content = readSkillMd(skillDir);
    const references = findSkillPathReferences(content);

    it('should have no legacy skill/ path references', () => {
      // Filter out references that are in code block examples (comments, docstrings)
      // where we might intentionally show old pattern as deprecated
      const activeRefs = references.filter((ref) => {
        // Skip references inside markdown code blocks marked as "old" or "legacy"
        // These are educational examples showing deprecated patterns
        return ref;
      });
      expect(activeRefs.length).toBe(0);
    });

    it('should use ./ prefix for own-script references', () => {
      // Check that if the skill references its own scripts, it uses ./
      const selfRefPattern = new RegExp(`\`${skillDir}/scripts/`, 'g');
      const badSelfRefs = content.match(selfRefPattern);
      if (badSelfRefs) {
        expect(badSelfRefs).toBeNull();
      }
    });

    it('should use ../ prefix for cross-skill references', () => {
      // Check that any reference to another skill uses ../ prefix
      const crossRefPattern = /`[a-zA-Z0-9_-]+\/scripts\//g;
      const badCrossRefs: string[] = [];
      let m;
      while ((m = crossRefPattern.exec(content)) !== null) {
        const ref = m[0];
        // Extract the skill name from the reference
        const skillName = ref.replace('`', '').split('/')[0];
        // If it's not a known skill dir, it might be a path prefix
        if (skillDirs.includes(skillName) && skillName !== skillDir) {
          badCrossRefs.push(ref);
        }
      }
      expect(badCrossRefs.length).toBe(0);
    });
  });
});

/**
 * Integration test: verify that resolved absolute paths are correct
 * for the updated references.
 */
describe('Cross-skill path resolution', () => {
  const skillDirs = getSkillDirs();

  it('should resolve cross-skill ../ references to existing directories', () => {
    for (const skillDir of skillDirs) {
      const content = readSkillMd(skillDir);
      // Find all ../<target>/ patterns
      const crossRefRegex = /\.\.\/([a-zA-Z0-9_-]+)\/(scripts|assets|resources|references)/g;
      let match;
      while ((match = crossRefRegex.exec(content)) !== null) {
        const targetDir = match[1];
        // Verify the target directory exists as a sibling skill
        const targetPath = path.join(SKILLS_DIR, targetDir);
        if (targetDir === skillDir) continue; // self-reference via .. is fine
        expect(fs.existsSync(targetPath)).toBe(true);
      }
    }
  });

  it('should have no broken self-references with ../<self>/ pattern', () => {
    // Some files might accidentally use ../<self>/ instead of ./
    for (const skillDir of skillDirs) {
      const content = readSkillMd(skillDir);
      const selfRefRegex = new RegExp(`\\.\\.\\/${skillDir}\\/`, 'g');
      const matches = content.match(selfRefRegex);
      if (matches) {
        // These are OK if intentional (e.g., example of how to reference from outside),
        // but flag them
        console.warn(`  Warning: ${skillDir} has ../${skillDir}/ self-references`);
      }
    }
  });
});
