import { describe, it, expect } from 'vitest';
import { normalizeActionArgs } from '../../src/commands/cli-utils.js';

describe('normalizeActionArgs', () => {
  it('extracts variadic ids and options from trailing command', () => {
    const raw = ['a', 'b', { opts: () => ({ foo: 'bar', nested: { x: 1 }, flag: true }) }];
    const normalized = normalizeActionArgs(raw as any, ['foo', 'flag']);
    expect(normalized.ids).toEqual(['a', 'b']);
    expect(normalized.options).toEqual({ foo: 'bar', flag: true });
    expect(normalized.provided.has('foo')).toBe(true);
    expect(normalized.provided.has('flag')).toBe(true);
    expect(normalized.provided.has('nested')).toBe(false);
  });

  it('accepts a single array of ids', () => {
    const raw = [['1', '2'], { opts: () => ({}) }];
    const normalized = normalizeActionArgs(raw as any);
    expect(normalized.ids).toEqual(['1', '2']);
  });

  it('prefers right-most .opts() object when multiple trailing objects present', () => {
    const raw = ['id', { some: 'val' }, { opts: () => ({ a: 1 }) }];
    const normalized = normalizeActionArgs(raw as any);
    expect(normalized.ids).toEqual(['id']);
    expect(normalized.options).toEqual({ a: 1 });
    expect(normalized.provided.has('a')).toBe(true);
  });

  it('filters non-primitive ids and coerces to strings', () => {
    const raw = [{}, 123, null, 'abc', { opts: () => ({}) }];
    const normalized = normalizeActionArgs(raw as any);
    // null is excluded, object is excluded; numbers are coerced
    expect(normalized.ids).toEqual(['123', 'abc']);
  });
});
