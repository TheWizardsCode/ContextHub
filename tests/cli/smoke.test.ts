import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { test, expect } from 'vitest';

test('dist CLI loads without syntax errors and prints version', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
  const res = spawnSync(process.execPath, ['dist/cli.js', '--version'], { encoding: 'utf8' });
  // Ensure process executed and exited successfully
  expect(res.error).toBeUndefined();
  expect(res.status === 0 || res.status === null).toBeTruthy();
  // stdout should contain the package version
  expect((res.stdout || '').trim()).toContain(String(pkg.version));
  // stderr should be empty (no syntax errors printed)
  expect((res.stderr || '').trim()).toBe('');
});
