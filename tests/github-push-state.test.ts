import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readLastPushTimestamp, writeLastPushTimestamp } from '../src/github-push-state.js';

let tempDir: string;
let worklogDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-push-state-test-'));
  worklogDir = path.join(tempDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('readLastPushTimestamp', () => {
  it('returns null when file does not exist', () => {
    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBeNull();
  });

  it('returns null when .local directory does not exist', () => {
    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBeNull();
  });

  it('reads a valid timestamp', () => {
    const localDir = path.join(worklogDir, '.local');
    fs.mkdirSync(localDir, { recursive: true });
    const ts = '2025-06-15T10:30:00.000Z';
    fs.writeFileSync(
      path.join(localDir, 'github-push-state.json'),
      JSON.stringify({ lastPushAt: ts }, null, 2) + '\n',
      'utf8'
    );

    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBe(ts);
  });

  it('returns null and warns on malformed JSON', () => {
    const localDir = path.join(worklogDir, '.local');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, 'github-push-state.json'),
      'not valid json!!!',
      'utf8'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('Warning');
    warnSpy.mockRestore();
  });

  it('returns null and warns when lastPushAt is missing', () => {
    const localDir = path.join(worklogDir, '.local');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, 'github-push-state.json'),
      JSON.stringify({ foo: 'bar' }),
      'utf8'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('malformed');
    warnSpy.mockRestore();
  });

  it('returns null and warns when lastPushAt is not a valid date', () => {
    const localDir = path.join(worklogDir, '.local');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, 'github-push-state.json'),
      JSON.stringify({ lastPushAt: 'not-a-date' }),
      'utf8'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('malformed');
    warnSpy.mockRestore();
  });

  it('returns null and warns when lastPushAt is an empty string', () => {
    const localDir = path.join(worklogDir, '.local');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, 'github-push-state.json'),
      JSON.stringify({ lastPushAt: '' }),
      'utf8'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('returns null and warns when lastPushAt is a number', () => {
    const localDir = path.join(worklogDir, '.local');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, 'github-push-state.json'),
      JSON.stringify({ lastPushAt: 12345 }),
      'utf8'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('returns null and warns when file contains null', () => {
    const localDir = path.join(worklogDir, '.local');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, 'github-push-state.json'),
      'null',
      'utf8'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });
});

describe('writeLastPushTimestamp', () => {
  it('writes a valid timestamp file', () => {
    const ts = '2025-06-15T10:30:00.000Z';
    writeLastPushTimestamp(worklogDir, ts);

    const filePath = path.join(worklogDir, '.local', 'github-push-state.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ lastPushAt: ts });
  });

  it('creates .local directory if it does not exist', () => {
    const localDir = path.join(worklogDir, '.local');
    expect(fs.existsSync(localDir)).toBe(false);

    const ts = new Date().toISOString();
    writeLastPushTimestamp(worklogDir, ts);

    expect(fs.existsSync(localDir)).toBe(true);
    expect(fs.statSync(localDir).isDirectory()).toBe(true);
  });

  it('overwrites an existing file', () => {
    const ts1 = '2025-01-01T00:00:00.000Z';
    const ts2 = '2025-06-15T10:30:00.000Z';

    writeLastPushTimestamp(worklogDir, ts1);
    writeLastPushTimestamp(worklogDir, ts2);

    const filePath = path.join(worklogDir, '.local', 'github-push-state.json');
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.lastPushAt).toBe(ts2);
  });

  it('does not leave temp files on success', () => {
    const ts = new Date().toISOString();
    writeLastPushTimestamp(worklogDir, ts);

    const localDir = path.join(worklogDir, '.local');
    const files = fs.readdirSync(localDir);
    // Only the state file should exist
    expect(files).toEqual(['github-push-state.json']);
  });

  it('throws with descriptive error when directory cannot be created', () => {
    // Create a file where the .local directory should be so mkdir fails
    const localPath = path.join(worklogDir, '.local');
    fs.writeFileSync(localPath, 'blocker', 'utf8');

    expect(() => {
      writeLastPushTimestamp(worklogDir, new Date().toISOString());
    }).toThrow(/Failed to create directory/);
  });

  it('throws with descriptive error when write fails', () => {
    const localDir = path.join(worklogDir, '.local');
    fs.mkdirSync(localDir, { recursive: true });

    // Make the directory read-only so writeFileSync fails
    fs.chmodSync(localDir, 0o444);

    try {
      expect(() => {
        writeLastPushTimestamp(worklogDir, new Date().toISOString());
      }).toThrow(/Failed to write/);
    } finally {
      // Restore permissions for cleanup
      fs.chmodSync(localDir, 0o755);
    }
  });
});

describe('read/write roundtrip', () => {
  it('roundtrips a timestamp correctly', () => {
    const ts = '2025-06-15T10:30:00.000Z';
    writeLastPushTimestamp(worklogDir, ts);

    const result = readLastPushTimestamp(worklogDir);
    expect(result).toBe(ts);
  });

  it('handles multiple sequential writes and reads', () => {
    const timestamps = [
      '2025-01-01T00:00:00.000Z',
      '2025-03-15T12:00:00.000Z',
      '2025-06-15T10:30:00.000Z',
    ];

    for (const ts of timestamps) {
      writeLastPushTimestamp(worklogDir, ts);
      const result = readLastPushTimestamp(worklogDir);
      expect(result).toBe(ts);
    }
  });

  it('file format contains pretty-printed JSON with trailing newline', () => {
    const ts = '2025-06-15T10:30:00.000Z';
    writeLastPushTimestamp(worklogDir, ts);

    const filePath = path.join(worklogDir, '.local', 'github-push-state.json');
    const raw = fs.readFileSync(filePath, 'utf8');

    // Should be pretty-printed with 2-space indent
    expect(raw).toBe(JSON.stringify({ lastPushAt: ts }, null, 2) + '\n');
    // Should end with a newline
    expect(raw.endsWith('\n')).toBe(true);
  });
});
