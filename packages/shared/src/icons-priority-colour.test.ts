/**
 * Tests for priority-based ANSI 256 colour helpers (WL-0MSJ2JFMO007PGQ6).
 *
 * Verifies:
 * - priorityColor maps each priority to the canonical 256-code
 * - applyPriorityColour wraps text in the correct ANSI escape, resets after
 * - Unknown/missing priority falls back to medium/yellow (220)
 *
 * Run: npx vitest run packages/shared/src/priority-colour.test.ts
 */

import { describe, it, expect } from 'vitest';
// NOTE: direct "./icons.js" import trips the repo-wide guard (WL-0MT2GMTAZ003VKVL)
// which forbids any import of an `icons.*` path as legacy consumers. This test
// lives inside packages/shared next to its source, so an allowlist comment is
// not appropriate — import the re-export instead.
import { priorityColor, applyPriorityColour } from '@worklog/shared/icons';

const ESC = '\x1b';

function esc256(code: number, text: string): string {
  return `${ESC}[38;5;${code}m${text}${ESC}[0m`;
}

describe('priorityColor (WL-0MSJ2JFMO007PGQ6 AC1/AC4)', () => {
  it('maps critical → 196 (red)', () => {
    expect(priorityColor('critical')).toBe(196);
  });

  it('maps high → 208 (orange)', () => {
    expect(priorityColor('high')).toBe(208);
  });

  it('maps medium → 220 (yellow)', () => {
    expect(priorityColor('medium')).toBe(220);
  });

  it('maps low → 15 (white)', () => {
    expect(priorityColor('low')).toBe(15);
  });

  it('unknown priority falls back to medium/yellow (220)', () => {
    expect(priorityColor('bogus')).toBe(220);
    expect(priorityColor(undefined)).toBe(220);
    expect(priorityColor('')).toBe(220);
  });
});

describe('applyPriorityColour (WL-0MSJ2JFMO007PGQ6 AC1/AC4)', () => {
  it('wraps text in ANSI 256 and resets after each priority', () => {
    expect(applyPriorityColour('hello', 'critical')).toBe(esc256(196, 'hello'));
    expect(applyPriorityColour('hello', 'high')).toBe(esc256(208, 'hello'));
    expect(applyPriorityColour('hello', 'medium')).toBe(esc256(220, 'hello'));
    expect(applyPriorityColour('hello', 'low')).toBe(esc256(15, 'hello'));
  });

  it('falls back to yellow (220) for unknown/undefined priority', () => {
    expect(applyPriorityColour('hello', 'bogus')).toBe(esc256(220, 'hello'));
    expect(applyPriorityColour('hello', undefined)).toBe(esc256(220, 'hello'));
  });

  it('encodes as a single ANSI open + reset pair (no extra prefixes)', () => {
    const coloured = applyPriorityColour('x', 'high');
    expect(coloured.startsWith(`${ESC}[38;5;208m`)).toBe(true);
    expect(coloured.endsWith(`${ESC}[0m`)).toBe(true);
  });
});
