import { execaSync } from 'execa';
import { describe, it, expect } from 'vitest';
import * as path from 'path';

describe('CLI documentation validator (integrated)', () => {
  it('validator script exits zero and prints OK', () => {
    const script = path.resolve(__dirname, '..', 'scripts', 'validate-cli-md.cjs');
    const res = execaSync(process.execPath, [script], { encoding: 'utf-8' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('OK: All help commands present in CLI.md');
  });
});
