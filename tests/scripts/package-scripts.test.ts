import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Read the root package.json and return its scripts object.
 */
function getPackageScripts(): Record<string, string> {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const pkgPath = path.join(repoRoot, 'package.json');
  const data = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  expect(data.scripts).toBeDefined();
  expect(typeof data.scripts).toBe('object');
  return data.scripts as Record<string, string>;
}

describe('npm install script wiring', () => {
  it('defines an install script that chains install:plugin then install:pi-extension', () => {
    const scripts = getPackageScripts();
    expect(scripts.install).toBeDefined();
    // The install script must chain both install rules in the correct order.
    expect(scripts.install).toContain('install:plugin');
    expect(scripts.install).toContain('install:pi-extension');
    // install:plugin must appear before install:pi-extension in the chain.
    const pluginIdx = scripts.install.indexOf('install:plugin');
    const piExtIdx = scripts.install.indexOf('install:pi-extension');
    expect(pluginIdx).toBeLessThan(piExtIdx);
  });

  it('defines install:plugin that invokes scripts/install-herdr.sh', () => {
    const scripts = getPackageScripts();
    expect(scripts['install:plugin']).toBeDefined();
    expect(scripts['install:plugin']).toContain('install-herdr.sh');
  });

  it('does not remove or alter the postbuild hook', () => {
    const scripts = getPackageScripts();
    expect(scripts.postbuild).toContain('install-herdr.sh');
    expect(scripts.postbuild).toBe('bash ./scripts/install-herdr.sh');
  });

  it('does not remove or alter the existing install:pi-extension rule', () => {
    const scripts = getPackageScripts();
    expect(scripts['install:pi-extension']).toBeDefined();
    expect(scripts['install:pi-extension']).toBe('bash ./scripts/install-pi-extension.sh');
  });

  it('install:plugin targets scripts/install-herdr.sh (matching the postbuild convention)', () => {
    const scripts = getPackageScripts();
    expect(scripts['install:plugin']).toBe(scripts.postbuild);
  });

  it('install script uses npm run (not bash) for chained rules', () => {
    const scripts = getPackageScripts();
    // The install script should invoke sub-rules via npm run, not bash directly.
    expect(scripts.install).toMatch(/npm\s+run/);
    // Neither sub-rule should use bash directly in the install script.
    expect(scripts.install).not.toMatch(/bash/);
  });

  it('install:plugin script is executable (the target shell script exists)', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'install-herdr.sh');
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it('install:pi-extension script is executable (the target shell script exists)', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'install-pi-extension.sh');
    expect(fs.existsSync(scriptPath)).toBe(true);
  });
});
