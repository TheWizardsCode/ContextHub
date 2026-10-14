import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * src/version.ts is auto-generated (`scripts/generate-version.cjs`, wired into
 * `npm run build`) and holds the CLI's canonical WORKLOG_VERSION. A package.json
 * version bump that forgets to regenerate it causes the CLI to report a stale
 * version, which the init tests catch as "expected X to be <package.json>".
 * This guard fails fast so the drift surfaces at test time, not after release.
 */
describe('version parity', () => {
  it('src/version.ts WORKLOG_VERSION matches package.json version', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    const versionSrc = fs.readFileSync(path.join(repoRoot, 'src', 'version.ts'), 'utf8');
    const match = versionSrc.match(/WORKLOG_VERSION = '([^']+)'/);
    expect(match, `WORKLOG_VERSION export not found in src/version.ts`).not.toBeNull();
    expect(match![1]).toBe(pkg.version);
  });
});
