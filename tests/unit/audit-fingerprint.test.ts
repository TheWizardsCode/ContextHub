/**
 * Canonical audit content fingerprint (TypeScript port) — unit tests
 * (WL-0MUN7QWFP0010EQC).
 *
 * These tests pin the pure pieces (Python-compatible canonical JSON, Key Files
 * extraction, path normalisation, touched-file resolution, path states) and
 * the failure modes (git unavailable → `null`, fail-safe). Byte-for-byte
 * equivalence with the canonical Python implementation is covered separately
 * in `audit-fingerprint-parity.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  computeContentFingerprint,
  computePathFingerprints,
  extractKeyFiles,
  normaliseRepoPath,
  parsePorcelainPath,
  resolveTouchedFiles,
  type GitResult,
  type GitRunner,
} from '../../src/audit-fingerprint.js';

/** A git runner that answers from fixed fixture outputs. */
function fixtureRunner(opts: {
  allLog?: string;
  logAllOk?: boolean;
  status?: string;
  statusOk?: boolean;
  diff?: string;
  diffOk?: boolean;
  heads?: Record<string, string | null>; // null → not at HEAD (fall back to log -1)
  singleLog?: string;
  singleLogOk?: boolean;
} = {}): GitRunner {
  return (args: string[]): GitResult => {
    if (args[0] === 'log' && args.includes('--all')) {
      return { ok: opts.logAllOk ?? true, stdout: opts.allLog ?? '' };
    }
    if (args[0] === 'status') {
      return { ok: opts.statusOk ?? true, stdout: opts.status ?? '' };
    }
    if (args[0] === 'diff') {
      return { ok: opts.diffOk ?? true, stdout: opts.diff ?? '' };
    }
    if (args[0] === 'rev-parse') {
      const path = args[1].slice('HEAD:'.length);
      const head = opts.heads?.[path];
      if (head === undefined || head === null) return { ok: false, stdout: '' };
      return { ok: true, stdout: `${head}\n` };
    }
    if (args[0] === 'log') {
      return { ok: opts.singleLogOk ?? true, stdout: opts.singleLog ?? '' };
    }
    return { ok: true, stdout: '' };
  };
}

describe('canonicalJson (Python json.dumps(sort_keys=True) compatibility)', () => {
  it('sorts object keys recursively and uses Python separators', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a": 2, "b": 1}');
    expect(canonicalJson({ z: { b: 'x', a: 'y' }, a: [] })).toBe(
      '{"a": [], "z": {"a": "y", "b": "x"}}',
    );
  });

  it('preserves array order', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b", "a"]');
  });

  it('escapes non-ASCII as \\uXXXX (ensure_ascii) including surrogate pairs', () => {
    expect(canonicalJson('café')).toBe('"caf\\u00e9"');
    expect(canonicalJson('😀')).toBe('"\\ud83d\\ude00"');
  });

  it('escapes control characters but leaves DEL (U+007F) and "/" literal', () => {
    expect(canonicalJson('a\nb')).toBe('"a\\nb"');
    expect(canonicalJson('a/b')).toBe('"a/b"');
    expect(canonicalJson('\u007f')).toBe('"\u007f"');
  });

  it('escapes quotes and backslashes', () => {
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('extractKeyFiles', () => {
  it('returns backtick-quoted paths under a Key Files heading', () => {
    const desc = [
      '## Summary',
      'text',
      '## Key Files',
      '- `src/a.ts` — the A helper',
      '- `src/b.ts`',
      '',
      '## Notes',
      '- `ignored.ts`',
    ].join('\n');
    expect(extractKeyFiles(desc)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('supports heading variants and the bullet fallback', () => {
    const desc = ['### Key Files (predicted)', '- src/plain.ts', ''].join('\n');
    expect(extractKeyFiles(desc)).toEqual(['src/plain.ts']);
  });

  it('returns an empty list when there is no Key Files section', () => {
    expect(extractKeyFiles('## Summary\nno files here')).toEqual([]);
    expect(extractKeyFiles('')).toEqual([]);
  });
});

describe('normaliseRepoPath', () => {
  it('strips backticks, quotes and a leading ./', () => {
    expect(normaliseRepoPath('`src/a.ts`')).toBe('src/a.ts');
    expect(normaliseRepoPath('"./src/a.ts"')).toBe('src/a.ts');
    expect(normaliseRepoPath('  ./src/a.ts  ')).toBe('src/a.ts');
  });
});

describe('parsePorcelainPath', () => {
  it('parses plain and rename entries', () => {
    expect(parsePorcelainPath(' M src/a.ts')).toBe('src/a.ts');
    expect(parsePorcelainPath('?? src/new.ts')).toBe('src/new.ts');
    expect(parsePorcelainPath('R  old.ts -> new.ts')).toBe('new.ts');
    expect(parsePorcelainPath('XY')).toBe('');
  });
});

describe('resolveTouchedFiles', () => {
  it('unions commit-referenced files and Key Files, sorted and de-duplicated', () => {
    const runner = fixtureRunner({
      allLog: [
        '__WL_COMMIT__abc',
        'src/b.ts',
        'src/a.ts',
        '__WL_COMMIT__def',
        'src/a.ts',
        '',
      ].join('\n'),
    });
    const desc = '## Key Files\n- `src/c.ts`';
    expect(resolveTouchedFiles('CFP-1', desc, runner)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('returns null when the git log probe fails (fail-safe)', () => {
    const runner = fixtureRunner({ logAllOk: false });
    expect(resolveTouchedFiles('CFP-1', '## Key Files\n- `src/a.ts`', runner)).toBeNull();
  });

  it('returns null when no paths are recorded', () => {
    const runner = fixtureRunner();
    expect(resolveTouchedFiles('CFP-1', 'no key files', runner)).toBeNull();
  });
});

describe('computePathFingerprints', () => {
  it('records HEAD blob state and the narrowed working-tree state', () => {
    const runner = fixtureRunner({
      heads: { 'src/a.ts': 'blobhash', 'src/b.ts': 'blobhash2' },
      status: ' M src/a.ts',
      diff: 'src/b.ts',
    });
    const states = computePathFingerprints(['src/a.ts', 'src/b.ts'], runner);
    expect(states).toEqual({
      'src/a.ts': { head: 'blobhash', worktree: 'M src/a.ts' },
      'src/b.ts': { head: 'blobhash2', worktree: 'src/b.ts' },
    });
  });

  it('falls back to the latest commit when the path is not at HEAD', () => {
    const runner = fixtureRunner({ heads: { 'src/a.ts': null }, singleLog: 'deadbeef\n' });
    const states = computePathFingerprints(['src/a.ts'], runner);
    expect(states).toEqual({ 'src/a.ts': { head: 'deadbeef', worktree: '' } });
  });

  it('returns null when a required git probe fails', () => {
    const runner = fixtureRunner({ statusOk: false });
    expect(computePathFingerprints(['src/a.ts'], runner)).toBeNull();
  });
});

describe('computeContentFingerprint', () => {
  const baseRunner = () =>
    fixtureRunner({
      allLog: '__WL_COMMIT__abc\nsrc/a.ts\n',
      heads: { 'src/a.ts': 'blobhash' },
      status: '',
      diff: '',
    });

  it('produces a deterministic 64-hex digest', () => {
    const first = computeContentFingerprint({
      id: 'CFP-1',
      description: '## Key Files\n- `src/a.ts`',
      runGit: baseRunner(),
    });
    const second = computeContentFingerprint({
      id: 'CFP-1',
      description: '## Key Files\n- `src/a.ts`',
      runGit: baseRunner(),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
  });

  it('changes when a touched path blob changes', () => {
    const before = computeContentFingerprint({
      id: 'CFP-1',
      description: '## Key Files\n- `src/a.ts`',
      runGit: baseRunner(),
    });
    const after = computeContentFingerprint({
      id: 'CFP-1',
      description: '## Key Files\n- `src/a.ts`',
      runGit: fixtureRunner({
        allLog: '__WL_COMMIT__abc\nsrc/a.ts\n',
        heads: { 'src/a.ts': 'differentblob' },
      }),
    });
    expect(before).not.toBe(after);
  });

  it('changes when the working tree is dirty for a touched path', () => {
    const before = computeContentFingerprint({
      id: 'CFP-1',
      description: '## Key Files\n- `src/a.ts`',
      runGit: baseRunner(),
    });
    const after = computeContentFingerprint({
      id: 'CFP-1',
      description: '## Key Files\n- `src/a.ts`',
      runGit: fixtureRunner({
        allLog: '__WL_COMMIT__abc\nsrc/a.ts\n',
        heads: { 'src/a.ts': 'blobhash' },
        status: ' M src/a.ts',
      }),
    });
    expect(before).not.toBe(after);
  });

  it('changes when the description changes', () => {
    const before = computeContentFingerprint({
      id: 'CFP-1',
      description: '## Key Files\n- `src/a.ts`',
      runGit: baseRunner(),
    });
    const after = computeContentFingerprint({
      id: 'CFP-1',
      description: '## Key Files\n- `src/a.ts`\n\nedited',
      runGit: baseRunner(),
    });
    expect(before).not.toBe(after);
  });

  it('returns null (fail-safe) when git is unavailable', () => {
    const runner: GitRunner = () => ({ ok: false, stdout: '' });
    expect(
      computeContentFingerprint({ id: 'CFP-1', description: 'x', runGit: runner }),
    ).toBeNull();
  });
});
