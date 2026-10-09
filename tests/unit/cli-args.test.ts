/**
 * Unit tests for normalizeFieldsArgv (WL-0MSLW8GHQ0092PJK).
 *
 * Users write `--fields id, title` with a space after the comma; the shell
 * splits that into separate argv tokens. normalizeFieldsArgv merges the
 * continuation tokens back into the --fields value when (and only when) the
 * accumulated value ends with a comma, so the projection does not silently
 * drop requested fields or mistake them for a positional search/query term.
 */

import { describe, it, expect } from 'vitest';
import { normalizeFieldsArgv, normalizeParentId } from '../../src/cli-utils.js';

describe('normalizeFieldsArgv', () => {
  it('leaves argv without --fields unchanged', () => {
    const argv = ['list', '--json', '--stage', 'in_review'];
    expect(normalizeFieldsArgv(argv)).toEqual(argv);
  });

  it('merges a two-field space-separated value', () => {
    expect(normalizeFieldsArgv(['list', '--fields', 'id,', 'title', '--json'])).toEqual([
      'list',
      '--fields',
      'id,title',
      '--json',
    ]);
  });

  it('merges three or more space-separated fields', () => {
    expect(
      normalizeFieldsArgv(['list', '--fields', 'id,', 'title,', 'status', '--json'])
    ).toEqual(['list', '--fields', 'id,title,status', '--json']);
  });

  it('merges the -f shorthand', () => {
    expect(normalizeFieldsArgv(['list', '-f', 'id,', 'title'])).toEqual([
      'list',
      '-f',
      'id,title',
    ]);
  });

  it('does not consume a positional search term when the value does not end with a comma', () => {
    // `--fields id,title` is complete; `searchterm` is a positional argument.
    expect(normalizeFieldsArgv(['list', '--fields', 'id,title', 'searchterm'])).toEqual([
      'list',
      '--fields',
      'id,title',
      'searchterm',
    ]);
  });

  it('preserves a positional argument that precedes --fields', () => {
    expect(normalizeFieldsArgv(['list', 'searchterm', '--fields', 'id,', 'title'])).toEqual([
      'list',
      'searchterm',
      '--fields',
      'id,title',
    ]);
  });

  it('does not consume an option token as a field continuation', () => {
    expect(normalizeFieldsArgv(['list', '--fields', 'id,', '--json', 'title'])).toEqual([
      'list',
      '--fields',
      'id,',
      '--json',
      'title',
    ]);
  });

  it('merges the --fields=<value> form', () => {
    expect(normalizeFieldsArgv(['list', '--fields=id,', 'title', '--json'])).toEqual([
      'list',
      '--fields=id,title',
      '--json',
    ]);
  });

  it('handles a trailing --fields with no value', () => {
    expect(normalizeFieldsArgv(['list', '--fields'])).toEqual(['list', '--fields']);
  });

  it('does not treat -f as --fields for commands where -f means --file', () => {
    // `wl export -f <path>` uses -f for --file; a comma must not merge the
    // following positional into the path.
    const argv = ['export', '-f', 'data,', 'backup', '--json'];
    expect(normalizeFieldsArgv(argv)).toEqual(argv);
  });

  it('leaves a quoted (single-token) value untouched', () => {
    expect(normalizeFieldsArgv(['list', '--fields', 'id, title', '--json'])).toEqual([
      'list',
      '--fields',
      'id, title',
      '--json',
    ]);
  });
});

/**
 * Unit tests for normalizeParentId (WL-0MUJM2LV1000IHKR).
 *
 * `wl update <id> --parent null` must detach the item (parentId -> null) rather
 * than producing the bogus literal `WL-NULL` parent that `normalizeCliId`
 * would otherwise build. The same sentinel is accepted by `wl create`.
 */
describe('normalizeParentId', () => {
  const PREFIX = 'TEST';

  it('maps the null sentinel to null', () => {
    expect(normalizeParentId('null', PREFIX)).toBeNull();
  });

  it('maps the null sentinel case-insensitively', () => {
    expect(normalizeParentId('NULL', PREFIX)).toBeNull();
    expect(normalizeParentId('Null', PREFIX)).toBeNull();
  });

  it('maps none/nil sentinels to null', () => {
    expect(normalizeParentId('none', PREFIX)).toBeNull();
    expect(normalizeParentId('NONE', PREFIX)).toBeNull();
    expect(normalizeParentId('nil', PREFIX)).toBeNull();
  });

  it('maps a lone dash to null', () => {
    expect(normalizeParentId('-', PREFIX)).toBeNull();
  });

  it('maps an empty string to null', () => {
    expect(normalizeParentId('', PREFIX)).toBeNull();
  });

  it('maps undefined to null', () => {
    expect(normalizeParentId(undefined, PREFIX)).toBeNull();
  });

  it('trims surrounding whitespace before matching a sentinel', () => {
    expect(normalizeParentId('  null  ', PREFIX)).toBeNull();
  });

  it('passes a full id through normalizeCliId unchanged', () => {
    expect(normalizeParentId('wl-0abc123', PREFIX)).toBe('WL-0ABC123');
    expect(normalizeParentId('WL-0ABC123', PREFIX)).toBe('WL-0ABC123');
  });

  it('prefixes a bare partial id', () => {
    expect(normalizeParentId('0abc123', PREFIX)).toBe('TEST-0ABC123');
  });
});
