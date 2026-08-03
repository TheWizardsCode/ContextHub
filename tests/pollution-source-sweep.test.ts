/**
 * Tests for the pollution-source sweep guard (WL-0MSALN28C000I62O).
 *
 * Verifies that the shared skill helper which resolves a target worklog
 * directory NEVER uses a hard-coded cross-project path — it derives the
 * directory dynamically from the current working directory / git root.
 * This guards against the original cross-project pollution vector
 * (hard-coded `--worklog-dir` pointing at another project).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createTempDir, cleanupTempDir } from './test-utils.js';

describe('shared worklog-dir resolution (pollution-source guard)', () => {
  it('resolves the worklog dir from cwd, not a hard-coded project path', async () => {
    // Run the helper directly in a temp dir that is NOT a real project.
    const tmp = createTempDir();
    try {
      const helper = path.resolve(__dirname, '..', '..', '..', '..', '..', '.pi', 'agent', 'skills', 'shared', 'status_lifecycle.py');
      // If the shared helper isn't present in this environment, skip gracefully.
      if (!fs.existsSync(helper)) return;

      // In a dir with no .worklog and no git root, the helper must return an
      // empty flag list (run wl as-is) rather than inventing a cross-project path.
      const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.dirname(helper))})
from status_lifecycle import worklog_dir_flag, _detect_worklog_dir
detected = _detect_worklog_dir()
flag = worklog_dir_flag()
print("DETECTED:", detected)
print("FLAG:", flag)
`;
      const res = execFileSync('python3', ['-c', script], {
        cwd: tmp,
        encoding: 'utf-8',
        env: { ...process.env, PATH: process.env.PATH || '' },
      });
      // Either no dir is detected (temp dir is not a project), or if one is
      // detected it must be inside the temp dir — never another project.
      const flagMatch = res.match(/FLAG: (\[.*\])/);
      expect(flagMatch).toBeTruthy();
      if (flagMatch && flagMatch[1] !== '[]') {
        const flag = JSON.parse(flagMatch[1]);
        expect(flag).toContain('--worklog-dir');
        const dirIdx = flag.indexOf('--worklog-dir') + 1;
        const dir = flag[dirIdx];
        expect(dir.startsWith(tmp)).toBe(true);
        expect(dir).not.toMatch(/SorraAgents|Tableau-Card-Engine|open_source_llm/);
      }
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('skills scripts contain no hard-coded cross-project --worklog-dir paths', () => {
    // Scan the skills tree (best-effort; skip if unavailable) for any script
    // that hard-codes another project's path in a --worklog-dir argument.
    const skillsRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', '.pi', 'agent', 'skills');
    if (!fs.existsSync(skillsRoot)) return;

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(py|sh|js|ts|mjs|cjs)$/.test(entry.name)) {
          try {
            const content = fs.readFileSync(p, 'utf-8');
            // Look for --worklog-dir referencing one of the known project roots.
            if (/--worklog-dir\s+["']?\/home\/rgardler\/projects\/(SorraAgents|Tableau-Card-Engine|open_source_llm)/.test(content)) {
              offenders.push(p);
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    };
    walk(skillsRoot);
    expect(offenders).toEqual([]);
  });
});
