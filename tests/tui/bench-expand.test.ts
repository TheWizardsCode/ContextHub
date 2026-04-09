import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import path from 'path';

describe('TUI expand/collapse benchmark', () => {
  it('runs headlessly and passes threshold', (done) => {
    const script = path.join(process.cwd(), 'bench', 'tui-expand.js');
    const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const child = execFile(tsx, [script], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        // If script exited non-zero, surface output for debugging
        done(new Error(`bench script failed: ${err.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      const out = String(stdout || '').trim();
      if (out.includes('PASS')) {
        done();
        return;
      }
      done(new Error(`bench did not PASS. stdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
});
