/**
 * Unit tests for stripCommandPrefix in index.ts
 *
 * Run: npx vitest run packages/herdr/src/index.test.ts
 */

import { describe, it, expect } from 'vitest';
import { stripCommandPrefix } from './index.js';

describe('stripCommandPrefix', () => {
  describe('double-bang prefix (!!)', () => {
    it('strips !! from commands starting with !!', () => {
      expect(stripCommandPrefix('!!wl update <id> --priority high')).toBe(
        'wl update <id> --priority high',
      );
    });

    it('strips !! from multi-command sequences', () => {
      expect(
        stripCommandPrefix(
          '!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes',
        ),
      ).toBe(
        'wl reviewed <id> false && wl audit-set <id> --ready-to-close yes',
      );
    });

    it('strips !! from search command', () => {
      expect(stripCommandPrefix('!!wl search ')).toBe('wl search ');
    });
  });

  describe('single-bang prefix (!)', () => {
    it('strips ! from commands starting with single !', () => {
      expect(stripCommandPrefix('!some shell command')).toBe('some shell command');
    });

    it('leaves !! commands unaffected by the single-bang rule', () => {
      // !! must be stripped first; a single-bang check should NOT fire
      expect(stripCommandPrefix('!!double-bang')).toBe('double-bang');
    });
  });

  describe('no prefix', () => {
    it('leaves agent commands unchanged (/skill:*)', () => {
      expect(stripCommandPrefix('/skill:implement <id>')).toBe(
        '/skill:implement <id>',
      );
    });

    it('leaves agent commands unchanged (/intake)', () => {
      expect(stripCommandPrefix('/intake')).toBe('/intake');
    });

    it('leaves agent commands unchanged (/plan)', () => {
      expect(stripCommandPrefix('/plan <id>')).toBe('/plan <id>');
    });

    it('leaves /wl filter commands unchanged', () => {
      expect(stripCommandPrefix('/wl idea')).toBe('/wl idea');
      expect(stripCommandPrefix('/wl review')).toBe('/wl review');
    });

    it('leaves plain commands without bang unchanged', () => {
      expect(stripCommandPrefix('echo hello')).toBe('echo hello');
    });

    it('leaves empty string unchanged', () => {
      expect(stripCommandPrefix('')).toBe('');
    });
  });

  describe('edge cases', () => {
    it('strips !! from !!wl close <id>', () => {
      expect(stripCommandPrefix('!!wl close <id>')).toBe('wl close <id>');
    });

    it('strips !! from !!wl delete <id>', () => {
      expect(stripCommandPrefix('!!wl delete <id>')).toBe('wl delete <id>');
    });

    it('strips !! from !!wl update <id> --status <status> --stage <stage>', () => {
      // Note: the shortcuts.json entry has a trailing space; stripCommandPrefix preserves it.
      expect(stripCommandPrefix('!!wl update <id> --status <status> --stage <stage> ')).toBe(
        'wl update <id> --status <status> --stage <stage> ',
      );
      // Also test without trailing space
      expect(stripCommandPrefix('!!wl update <id> --status <status> --stage <stage>')).toBe(
        'wl update <id> --status <status> --stage <stage>',
      );
    });

    it('strips !! from !!wl update <id> --title ', () => {
      expect(stripCommandPrefix('!!wl update <id> --title ')).toBe(
        'wl update <id> --title ',
      );
    });
  });
});
