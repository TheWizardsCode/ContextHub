// Utility helpers for parsing and decorating IDs in TUI output.
// Extracted from src/tui/controller.ts to improve reuse and testability.
export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

export function stripTags(value: string): string {
  return value.replace(/{[^}]+}/g, '');
}

export function decorateIdsForClick(value: string): string {
  return value.replace(/\b[A-Z][A-Z0-9]+-[A-Z0-9-]+\b/g, '{underline}$&{/underline}');
}

const ID_RE = /\b[A-Z][A-Z0-9]+-[A-Z0-9-]+\b/g;

export function extractIdFromLine(line: string): string | null {
  const plain = stripTags(stripAnsi(line));
  const match = plain.match(/\b[A-Z][A-Z0-9]+-[A-Z0-9-]+\b/);
  return match ? match[0] : null;
}

export function extractIdAtColumn(line: string, col?: number): string | null {
  const plain = stripTags(stripAnsi(line));
  const matches = Array.from(plain.matchAll(ID_RE));
  if (matches.length === 0) return null;
  if (typeof col !== 'number') return matches[0][0];
  for (const match of matches) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (col >= start && col <= end) return match[0];
  }
  return null;
}

export function stripTagsAndAnsiWithMap(value: string): { plain: string; map: number[] } {
  let plain = '';
  const map: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\u001b') {
      let j = i + 1;
      if (value[j] === '[') {
        j += 1;
        while (j < value.length && !/[A-Za-z]/.test(value[j])) j += 1;
        if (j < value.length) j += 1;
      }
      i = j - 1;
      continue;
    }
    if (ch === '{') {
      const closeIdx = value.indexOf('}', i + 1);
      if (closeIdx !== -1) {
        i = closeIdx;
        continue;
      }
    }
    plain += ch;
    map.push(i);
  }
  return { plain, map };
}

export function wrapPlainLineWithMap(plain: string, map: number[], width: number): Array<{ plain: string; map: number[] }> {
  if (width <= 0) return [{ plain, map }];
  const words = plain.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [{ plain: '', map: [] }];
  const chunks: Array<{ plain: string; map: number[] }> = [];
  let current = '';
  let currentMap: number[] = [];
  let cursor = 0;
  for (const word of words) {
    const startIdx = plain.indexOf(word, cursor);
    if (startIdx === -1) continue;
    const wordMap = map.slice(startIdx, startIdx + word.length);
    cursor = startIdx + word.length;
    if (current.length === 0) {
      if (word.length <= width) {
        current = word;
        currentMap = wordMap.slice();
      } else {
        for (let i = 0; i < word.length; i += width) {
          const part = word.slice(i, i + width);
          const partMap = wordMap.slice(i, i + width);
          chunks.push({ plain: part, map: partMap });
        }
      }
      continue;
    }
    if ((current.length + 1 + word.length) <= width) {
      current += ` ${word}`;
      currentMap = currentMap.concat(-1, ...wordMap);
    } else {
      chunks.push({ plain: current, map: currentMap });
      if (word.length <= width) {
        current = word;
        currentMap = wordMap.slice();
      } else {
        for (let i = 0; i < word.length; i += width) {
          const part = word.slice(i, i + width);
          const partMap = wordMap.slice(i, i + width);
          chunks.push({ plain: part, map: partMap });
        }
        current = '';
        currentMap = [];
      }
    }
  }
  if (current.length > 0) {
    chunks.push({ plain: current, map: currentMap });
  }
  return chunks;
}
