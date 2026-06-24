import { describe, it, expect } from 'vitest';
import {
  normalizePriority,
  isValidPriority,
  isMappablePriority,
  CANONICAL_PRIORITIES,
  PRIORITY_MAP,
} from '../../src/validators/priority.js';

describe('isValidPriority', () => {
  it('returns true for canonical values (case-insensitive)', () => {
    expect(isValidPriority('low')).toBe(true);
    expect(isValidPriority('medium')).toBe(true);
    expect(isValidPriority('high')).toBe(true);
    expect(isValidPriority('critical')).toBe(true);
    expect(isValidPriority('LOW')).toBe(true);
    expect(isValidPriority('Medium')).toBe(true);
    expect(isValidPriority('HIGH')).toBe(true);
    expect(isValidPriority('Critical')).toBe(true);
  });

  it('returns false for P* values', () => {
    expect(isValidPriority('P0')).toBe(false);
    expect(isValidPriority('P1')).toBe(false);
    expect(isValidPriority('p2')).toBe(false);
    expect(isValidPriority('p3')).toBe(false);
  });

  it('returns false for empty/whitespace', () => {
    expect(isValidPriority('')).toBe(false);
    expect(isValidPriority('   ')).toBe(false);
  });

  it('returns false for unknown tokens', () => {
    expect(isValidPriority('urgent')).toBe(false);
    expect(isValidPriority('normal')).toBe(false);
    expect(isValidPriority('')).toBe(false);
  });
});

describe('isMappablePriority', () => {
  it('returns true for P0-P3 (case-insensitive)', () => {
    expect(isMappablePriority('P0')).toBe(true);
    expect(isMappablePriority('P1')).toBe(true);
    expect(isMappablePriority('P2')).toBe(true);
    expect(isMappablePriority('P3')).toBe(true);
    expect(isMappablePriority('p0')).toBe(true);
    expect(isMappablePriority('p1')).toBe(true);
  });

  it('returns false for canonical values', () => {
    expect(isMappablePriority('low')).toBe(false);
    expect(isMappablePriority('critical')).toBe(false);
  });

  it('returns false for unknown tokens', () => {
    expect(isMappablePriority('urgent')).toBe(false);
    expect(isMappablePriority('P4')).toBe(false);
    expect(isMappablePriority('')).toBe(false);
  });
});

describe('normalizePriority', () => {
  it('normalizes canonical values case-insensitively', () => {
    expect(normalizePriority('low')).toBe('low');
    expect(normalizePriority('LOW')).toBe('low');
    expect(normalizePriority('Low')).toBe('low');
    expect(normalizePriority('MEDIUM')).toBe('medium');
    expect(normalizePriority('Medium')).toBe('medium');
    expect(normalizePriority('High')).toBe('high');
    expect(normalizePriority('CRITICAL')).toBe('critical');
  });

  it('maps P0-P3 to canonical values', () => {
    expect(normalizePriority('P0')).toBe('critical');
    expect(normalizePriority('P1')).toBe('high');
    expect(normalizePriority('P2')).toBe('medium');
    expect(normalizePriority('P3')).toBe('low');
    expect(normalizePriority('p0')).toBe('critical');
    expect(normalizePriority('p1')).toBe('high');
  });

  it('returns null for unknown tokens', () => {
    expect(normalizePriority('urgent')).toBeNull();
    expect(normalizePriority('normal')).toBeNull();
    expect(normalizePriority('')).toBeNull();
    expect(normalizePriority('   ')).toBeNull();
  });

  it('trims whitespace before normalizing', () => {
    expect(normalizePriority('  high  ')).toBe('high');
    expect(normalizePriority('  P1  ')).toBe('high');
  });

  it('returns null for null-like or undefined input coerced to string', () => {
    expect(normalizePriority('' as string)).toBeNull();
  });
});

describe('constants', () => {
  it('CANONICAL_PRIORITIES contains the four canonical values', () => {
    expect(CANONICAL_PRIORITIES).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('PRIORITY_MAP maps P0-P3 correctly', () => {
    expect(PRIORITY_MAP).toEqual({
      P0: 'critical',
      P1: 'high',
      P2: 'medium',
      P3: 'low',
    });
  });
});
