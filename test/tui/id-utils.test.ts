import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  stripTags,
  decorateIdsForClick,
  extractIdFromLine,
  extractIdAtColumn,
  stripTagsAndAnsiWithMap,
  wrapPlainLineWithMap,
} from '../../src/tui/id-utils.js';

describe('id-utils', () => {
  it('stripAnsi removes ANSI sequences', () => {
    const v = 'foo\u001b[31mRED\u001b[0mbar';
    expect(stripAnsi(v)).toBe('fooREDbar');
  });

  it('stripTags removes blessed-style tags', () => {
    const v = 'a{red-fg}X{/red-fg}b';
    expect(stripTags(v)).toBe('aXb');
  });

  it('decorateIdsForClick underlines IDs', () => {
    const v = 'See WL-ABC123-1 in the log';
    expect(decorateIdsForClick(v)).toContain('{underline}WL-ABC123-1{/underline}');
  });

  it('extractIdFromLine finds ID with ANSI/tags', () => {
    const v = '\u001b[31m{bold}WL-FOO-1{/bold}\u001b[0m';
    expect(extractIdFromLine(v)).toBe('WL-FOO-1');
  });

  it('extractIdAtColumn selects the id at a given column', () => {
    const v = 'prefix WL-ONE-1 middle WL-TWO-2 suffix';
    // ensure without column returns first
    expect(extractIdAtColumn(v)).toBe('WL-ONE-1');
    // compute index inside second id by finding plain index
    const plain = v;
    const i = plain.indexOf('WL-TWO-2');
    expect(i).toBeGreaterThan(-1);
    expect(extractIdAtColumn(v, i + 2)).toBe('WL-TWO-2');
  });

  it('stripTagsAndAnsiWithMap returns plain and map', () => {
    const v = 'A\u001b[31mB\u001b[0mC{red}D{/red}E';
    const out = stripTagsAndAnsiWithMap(v);
    expect(out.plain).toBe('ABCDE');
    expect(Array.isArray(out.map)).toBe(true);
    expect(out.map.length).toBe(5);
    for (const n of out.map) expect(typeof n).toBe('number');
  });

  it('wrapPlainLineWithMap returns single chunk when width large', () => {
    const plain = 'hello world';
    const map = Array.from(plain).map((_, i) => i);
    const chunks = wrapPlainLineWithMap(plain, map, 50);
    expect(chunks.length).toBe(1);
    expect(chunks[0].plain).toBe(plain);
    expect(Array.isArray(chunks[0].map)).toBe(true);
    expect(chunks[0].map.length).toBe(plain.length);
  });
});
