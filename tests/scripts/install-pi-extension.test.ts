import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('install-pi-extension script', () => {
  it('creates global ~/.pi/agent/extensions symlink to worklog extension directory', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-pi-ext-home-'));
    const scriptPath = path.join(repoRoot, 'scripts', 'install-pi-extension.sh');

    execFileSync('bash', [scriptPath], {
      cwd: repoRoot,
      stdio: 'pipe',
      env: { ...process.env, HOME: tempHome },
    });

    const linkPath = path.join(tempHome, '.pi', 'agent', 'extensions', 'worklog');
    expect(fs.existsSync(linkPath)).toBe(true);

    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = fs.readlinkSync(linkPath);
    const expectedTarget = path.join(repoRoot, 'packages', 'tui', 'extensions');
    expect(path.resolve(path.dirname(linkPath), target)).toBe(expectedTarget);

    // Re-run to verify idempotent replacement path
    execFileSync('bash', [scriptPath], {
      cwd: repoRoot,
      stdio: 'pipe',
      env: { ...process.env, HOME: tempHome },
    });
    const statAfter = fs.lstatSync(linkPath);
    expect(statAfter.isSymbolicLink()).toBe(true);
  });
});
