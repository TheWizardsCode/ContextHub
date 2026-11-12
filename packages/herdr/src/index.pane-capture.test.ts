/**
 * packages/herdr/src/index.pane-capture.test.ts — `parsePaneIdFile` and
 * dispatch-time pane-id association capture tests (WL-0MVOA238A0078J2H).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePaneIdFile, capturePaneIdFromFile, CAPTURE_TIMEOUT_MS } from './index.js';
import { setupHostCpuPin } from './index.fixtures.js';

setupHostCpuPin();

describe('parsePaneIdFile', () => {
  it('parses the pane_id written by send-to-pi.sh', () => {
    expect(parsePaneIdFile('{"pane_id":"grid-pane-5"}')).toBe('grid-pane-5');
    expect(parsePaneIdFile('{"pane_id": "plain-pane-1"}')).toBe('plain-pane-1');
  });

  it('tolerates log lines prefixed before the JSON', () => {
    expect(parsePaneIdFile('some noise\n{"pane_id":"p1"}')).toBe('p1');
  });

  it('returns undefined for unparseable content', () => {
    expect(parsePaneIdFile('')).toBeUndefined();
    expect(parsePaneIdFile('not json')).toBeUndefined();
    expect(parsePaneIdFile('{"no_pane":1}')).toBeUndefined();
  });
});

describe('capturePaneIdFromFile — dispatch-time association capture', () => {
  it('polls for the pane-id file, records the association, and cleans up', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const unlink = vi.fn();
    let fileExists = false;
    let fileContent = '';

    const promise = capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => fileExists,
      readFile: () => fileContent,
      unlink,
      sleep: async () => {
        // Simulate the pane-id file appearing after the first poll.
        fileExists = true;
        fileContent = '{"pane_id":"grid-pane-5"}';
      },
      now: () => 0,
    });

    const paneId = await promise;
    expect(paneId).toBe('grid-pane-5');
    expect(record).toHaveBeenCalledWith('WL-ABC', 'grid-pane-5');
    expect(unlink).toHaveBeenCalledWith('/tmp/pane.json');
  });

  it('records nothing when the file never appears (split failed)', async () => {
    const record = vi.fn();
    let t = 0;
    const paneId = await capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => false,
      readFile: () => '',
      // Advance the clock past the deadline so the loop terminates (a
      // constant `now` would make the timeout unreachable and spin forever).
      sleep: async () => { t += CAPTURE_TIMEOUT_MS; },
      now: () => t,
    });
    expect(paneId).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('is fail-open: a recording error never throws', async () => {
    const record = vi.fn().mockRejectedValue(new Error('tracker boom'));
    const unlink = vi.fn();
    const paneId = await capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => true,
      readFile: () => '{"pane_id":"p1"}',
      unlink,
      sleep: async () => {},
      now: () => 0,
    });
    expect(paneId).toBe('p1');
    expect(record).toHaveBeenCalledWith('WL-ABC', 'p1');
    expect(unlink).toHaveBeenCalledWith('/tmp/pane.json');
  });

  it('keeps polling while the file is unreadable or mid-write', async () => {
    const record = vi.fn();
    let readable = false;
    const paneId = await capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => true,
      readFile: () => {
        if (!readable) throw new Error('mid-write');
        return '{"pane_id":"p1"}';
      },
      sleep: async () => { readable = true; },
      now: () => 0,
    });
    expect(paneId).toBe('p1');
    expect(record).toHaveBeenCalledWith('WL-ABC', 'p1');
  });

  it('gives up once the timeout is reached', async () => {
    const record = vi.fn();
    let t = 0;
    const paneId = await capturePaneIdFromFile('WL-ABC', '/tmp/pane.json', record, {
      existsSync: () => true,
      readFile: () => 'not json',
      sleep: async () => { t += 200; },
      now: () => t,
    });
    expect(paneId).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });
});
