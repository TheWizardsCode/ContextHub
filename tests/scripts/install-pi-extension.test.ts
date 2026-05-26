import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('install-pi-extension script', () => {
  it('creates project .pi/extensions symlink to worklog extension directory', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-pi-ext-'));
    const scriptPath = path.join(repoRoot, 'scripts', 'install-pi-extension.sh');

    execFileSync('bash', [scriptPath, workDir], { cwd: repoRoot, stdio: 'pipe' });

    const linkPath = path.join(workDir, '.pi', 'extensions', 'worklog');
    expect(fs.existsSync(linkPath)).toBe(true);

    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = fs.readlinkSync(linkPath);
    const expectedTarget = path.join(repoRoot, 'packages', 'tui', 'extensions');
    expect(path.resolve(path.dirname(linkPath), target)).toBe(expectedTarget);

    // Re-run to verify idempotent replacement path
    execFileSync('bash', [scriptPath, workDir], { cwd: repoRoot, stdio: 'pipe' });
    const statAfter = fs.lstatSync(linkPath);
    expect(statAfter.isSymbolicLink()).toBe(true);
  });
});
