import { execaSync } from 'execa';
import { describe, it, expect } from 'vitest';
import * as path from 'path';

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');

describe('Help grouping', () => {
  it('prints commands under the expected groups in order', () => {
    const result = execaSync(process.execPath, [cli, '--help'], { encoding: 'utf-8' });
    expect(result.exitCode).toBe(0);
    const out = result.stdout;

    const groups = ['Issue Management:', 'Status:', 'Team:', 'Maintenance:', 'Plugins:'];
    const expected: Record<string, string[]> = {
      'Issue Management:': ['create', 'update', 'delete', 'comment', 'close'],
      'Status:': ['list', 'show', 'next', 'in-progress', 'recent'],
      'Team:': ['export', 'import', 'sync', 'github'],
      'Maintenance:': ['migrate'],
      'Plugins:': ['plugins']
    };

    const indices: Record<string, number> = {};
    for (const g of groups) {
      const i = out.indexOf(g);
      expect(i).toBeGreaterThanOrEqual(0);
      indices[g] = i;
    }

    // Ensure group order
    for (let i = 1; i < groups.length; i++) {
      expect(indices[groups[i]]).toBeGreaterThan(indices[groups[i - 1]]);
    }

    // Ensure each expected command appears within its group section
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const start = indices[g];
      const end = gi + 1 < groups.length ? indices[groups[gi + 1]] : out.length;

      for (const cmd of expected[g]) {
        const cmdIdx = out.indexOf(cmd, start);
        expect(cmdIdx).toBeGreaterThanOrEqual(0);
        expect(cmdIdx).toBeLessThan(end);
      }
    }
  });
});
