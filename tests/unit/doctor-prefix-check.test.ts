/**
 * Unit tests for the `wl doctor prefix` pure helpers
 * (WL-0MVZ2U295000GJ8M, parent WL-0MVM8V79C003XH2J).
 *
 * Green today: `extractIdPrefix` is the shared ID-prefix helper the rename
 * reuses (`src/doctor/foreign-items-check.ts`), so those specs run against the
 * real implementation.
 *
 * RED-pinned: the new helpers live in `src/doctor/prefix-check.ts`, which the
 * implementation child (WL-0MVZ2U4E0003IVSZ) adds. Until it lands every spec
 * that needs it is wrapped in `it.fails(...)` so the gated suite stays green;
 * the implementation child flips `it.fails(` → `it(` as the module lands. The
 * module is imported dynamically so this file loads before it exists.
 *
 * Contract exercised here (mirrored by `tests/cli/doctor-prefix.test.ts`):
 *
 *  - `validateTargetPrefix(value)` → `{ valid: boolean, error?: string }`
 *    Valid: non-empty, ASCII alphanumeric only, no `-` (and no whitespace,
 *    punctuation or non-ASCII letters). Invalid values carry a non-empty
 *    `error` message naming the problem.
 *  - `renameId(id, fromPrefix, toPrefix)` → suffix-preserving renumbering.
 *    Only the substring before the FIRST `-` changes; `fromPrefix` is matched
 *    case-insensitively; IDs without a `-` and IDs with a different prefix are
 *    returned unchanged.
 *  - `decidePrefixConfirmation({ confirm, stdinIsTTY, answer })` →
 *    `{ proceed: boolean, prompt: boolean }`:
 *      · `confirm: true` → proceed, never prompt;
 *      · non-TTY without `confirm` → never prompt, never proceed (fail closed);
 *      · TTY without `confirm` → prompt; proceed only when the trimmed,
 *        lowercased answer is exactly `y` (`yes`, `n`, empty and anything else
 *        decline).
 */

import { describe, it, expect } from 'vitest';
import { extractIdPrefix } from '../../src/doctor/foreign-items-check.js';

interface PrefixCheckModule {
  validateTargetPrefix: (value: string) => { valid: boolean; error?: string };
  renameId: (id: string, fromPrefix: string, toPrefix: string) => string;
  decidePrefixConfirmation: (input: {
    confirm?: boolean;
    stdinIsTTY: boolean;
    answer?: string | null;
  }) => { proceed: boolean; prompt: boolean };
}

/** Resolve the prefix-check module once the implementation adds it (throws today). */
async function loadPrefixCheck(): Promise<PrefixCheckModule> {
  return (await import('../../src/doctor/prefix-check.js')) as PrefixCheckModule;
}

describe('extractIdPrefix (shared helper reused by the rename)', () => {
  it('returns the substring before the first dash', () => {
    expect(extractIdPrefix('WL-0MSAH2A71000MUA3')).toBe('WL');
    expect(extractIdPrefix('OSL-0MVK31VYQ007CN37')).toBe('OSL');
  });

  it('returns null when the ID has no dash separator', () => {
    expect(extractIdPrefix('NODASH123')).toBeNull();
  });

  it('returns null for an empty prefix', () => {
    expect(extractIdPrefix('-LEADINGDASH')).toBeNull();
  });

  it('splits only on the first dash', () => {
    expect(extractIdPrefix('OSL-ABC-DEF')).toBe('OSL');
  });
});

describe('validateTargetPrefix (--to validation)', () => {
  it.fails('accepts non-empty ASCII alphanumeric prefixes', async () => {
    const { validateTargetPrefix } = await loadPrefixCheck();

    for (const value of ['CC', 'cc', 'C1', 'OSL', 'A']) {
      const result = validateTargetPrefix(value);
      expect(result.valid, `expected ${JSON.stringify(value)} to be valid`).toBe(true);
      expect(result.error ?? '').toBe('');
    }
  });

  it.fails('rejects an empty or whitespace-only prefix', async () => {
    const { validateTargetPrefix } = await loadPrefixCheck();

    for (const value of ['', '   ', '\t']) {
      const result = validateTargetPrefix(value);
      expect(result.valid, `expected ${JSON.stringify(value)} to be invalid`).toBe(false);
      expect(result.error ?? '').not.toBe('');
    }
  });

  it.fails('rejects a prefix containing a dash', async () => {
    const { validateTargetPrefix } = await loadPrefixCheck();

    for (const value of ['C-C', '-CC', 'CC-']) {
      const result = validateTargetPrefix(value);
      expect(result.valid, `expected ${JSON.stringify(value)} to be invalid`).toBe(false);
      expect(result.error ?? '').not.toBe('');
    }
  });

  it.fails('rejects non-ASCII-alphanumeric characters', async () => {
    const { validateTargetPrefix } = await loadPrefixCheck();

    for (const value of ['C_C', 'CC 1', 'CC!', 'Café', ' WI']) {
      const result = validateTargetPrefix(value);
      expect(result.valid, `expected ${JSON.stringify(value)} to be invalid`).toBe(false);
      expect(result.error ?? '').not.toBe('');
    }
  });
});

describe('renameId (suffix-preserving rename mapping)', () => {
  it.fails('renames only the prefix and preserves the suffix', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('OSL-0MVK31VYQ007CN37', 'OSL', 'CC')).toBe('CC-0MVK31VYQ007CN37');
    expect(renameId('TEST-SAMPLE', 'TEST', 'CC')).toBe('CC-SAMPLE');
  });

  it.fails('changes only the substring before the first dash', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('TEST-A-B', 'TEST', 'CC')).toBe('CC-A-B');
  });

  it.fails('leaves an ID without a dash unchanged', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('NODASH123', 'TEST', 'CC')).toBe('NODASH123');
  });

  it.fails('leaves an ID carrying a different prefix unchanged', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('OTHER-1', 'TEST', 'CC')).toBe('OTHER-1');
  });

  it.fails('matches the source prefix case-insensitively', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('test-1', 'TEST', 'CC')).toBe('CC-1');
  });

  it.fails('is a no-op when source and target prefixes are equal', async () => {
    const { renameId } = await loadPrefixCheck();

    expect(renameId('CC-1', 'CC', 'CC')).toBe('CC-1');
  });
});

describe('decidePrefixConfirmation (confirmation gate)', () => {
  it.fails('proceeds without prompting when --confirm is given', async () => {
    const { decidePrefixConfirmation } = await loadPrefixCheck();

    expect(decidePrefixConfirmation({ confirm: true, stdinIsTTY: false })).toEqual({
      proceed: true,
      prompt: false,
    });
    expect(decidePrefixConfirmation({ confirm: true, stdinIsTTY: true })).toEqual({
      proceed: true,
      prompt: false,
    });
  });

  it.fails('fails closed without prompting when stdin is not a TTY', async () => {
    const { decidePrefixConfirmation } = await loadPrefixCheck();

    for (const answer of [undefined, null, 'y', 'yes']) {
      expect(
        decidePrefixConfirmation({ confirm: false, stdinIsTTY: false, answer }),
      ).toEqual({ proceed: false, prompt: false });
    }
  });

  it.fails('prompts on a TTY and proceeds only for an explicit y', async () => {
    const { decidePrefixConfirmation } = await loadPrefixCheck();

    expect(decidePrefixConfirmation({ confirm: false, stdinIsTTY: true })).toEqual({
      proceed: false,
      prompt: true,
    });
    expect(
      decidePrefixConfirmation({ confirm: false, stdinIsTTY: true, answer: 'y' }),
    ).toEqual({ proceed: true, prompt: true });
    expect(
      decidePrefixConfirmation({ confirm: false, stdinIsTTY: true, answer: ' Y ' }),
    ).toEqual({ proceed: true, prompt: true });
  });

  it.fails('declines the prompt for anything other than y', async () => {
    const { decidePrefixConfirmation } = await loadPrefixCheck();

    for (const answer of ['yes', 'n', 'no', '', 'true']) {
      expect(
        decidePrefixConfirmation({ confirm: false, stdinIsTTY: true, answer }),
      ).toEqual({ proceed: false, prompt: true });
    }
  });
});
