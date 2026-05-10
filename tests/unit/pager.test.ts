import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pageOutput from '../../src/pager.js';
import * as child from 'child_process';

describe('pager', () => {
  let origIsTTY: any;
  let origRows: any;
  let writeSpy: any;

  beforeEach(() => {
    origIsTTY = process.stdout.isTTY;
    origRows = (process.stdout as any).rows;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as any);
  });

  afterEach(() => {
    process.stdout.isTTY = origIsTTY;
    (process.stdout as any).rows = origRows;
    writeSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('writes directly when not a TTY', () => {
    process.stdout.isTTY = false as any;
    pageOutput('hello\nworld\n');
    expect(writeSpy).toHaveBeenCalled();
  });

  it('does not spawn pager when content fits terminal', () => {
    process.stdout.isTTY = true as any;
    (process.stdout as any).rows = 10;
    const spawnSpy = vi.spyOn(child, 'spawnSync');
    pageOutput('line1\nline2\n');
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
  });

  it('spawns pager when content exceeds terminal rows', () => {
    process.stdout.isTTY = true as any;
    (process.stdout as any).rows = 1;
    const spawnSpy = vi.spyOn(child, 'spawnSync').mockImplementation(() => ({ status: 0 } as any));
    pageOutput('line1\nline2\nline3\n');
    expect(spawnSpy).toHaveBeenCalled();
  });

  it('respects noPager flag', () => {
    process.stdout.isTTY = true as any;
    (process.stdout as any).rows = 1;
    const spawnSpy = vi.spyOn(child, 'spawnSync');
    pageOutput('line1\nline2\n', { noPager: true });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
  });
});
