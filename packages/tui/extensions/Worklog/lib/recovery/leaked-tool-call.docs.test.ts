/**
 * Documentation contract for leaked tool-call recovery.
 *
 * WL-0MW109JWM000QOEJ AC4/AC5: the extension README must document the
 * capability, be reachable from its table of contents and category table, and
 * print the defaults that `LEAKED_TOOL_CALL_CONFIG` actually declares. Docs
 * that drift from the code are a defect — an operator following a stale
 * default or a renamed file is misled — so this test compares the two rather
 * than trusting either side.
 *
 * It asserts documentation facts only (headings, table row, the settings
 * fence, the recorded Pi contract); the behaviour itself is covered by
 * `leaked-tool-call.test.ts` and `register-leaked-tool-call.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEAKED_TOOL_CALL_CONFIG } from './leaked-tool-call.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(HERE, '../../../README.md');
const readme = readFileSync(README_PATH, 'utf8');

const HEADING = '### Leaked tool-call recovery';
const ANCHOR = '#leaked-tool-call-recovery';

/** The README's leading table of contents (everything before the first `## `). */
function contents(): string {
  return readme.slice(0, readme.indexOf('\n## '));
}

/** The body of the `### Leaked tool-call recovery` subsection. */
function recoverySection(): string {
  const start = readme.indexOf(HEADING);
  expect(start, `missing "${HEADING}" in ${README_PATH}`).toBeGreaterThan(-1);
  const rest = readme.slice(start + HEADING.length);
  const next = rest.indexOf('\n### ');
  return next === -1 ? rest : rest.slice(0, next);
}

/** Every fenced code block in `text` whose info string is `lang`. */
function fences(text: string, lang: string): string[] {
  const pattern = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g');
  return Array.from(text.matchAll(pattern), (match) => match[1]);
}

describe('leaked tool-call recovery documentation', () => {
  it('links the subsection from the table of contents', () => {
    expect(contents()).toContain(`[Leaked tool-call recovery](${ANCHOR})`);
  });

  it('lists the leakedToolCall category with its default action', () => {
    const start = readme.indexOf('### Error Categories');
    expect(start).toBeGreaterThan(-1);
    const row = readme
      .slice(start)
      .split('\n')
      .find((line) => line.startsWith('| `leakedToolCall`'));

    expect(row, 'no leakedToolCall row in the Error Categories table').toBeDefined();
    expect(row).toContain('Repair, else one corrective continue');
    expect(row).toContain(ANCHOR);
  });

  it('documents the LEAKED_TOOL_CALL_CONFIG defaults exactly', () => {
    const blocks = fences(recoverySection(), 'json');
    expect(blocks).toHaveLength(1);

    expect(JSON.parse(blocks[0])).toEqual({ ...LEAKED_TOOL_CALL_CONFIG });
  });

  it('records the Pi contract the repair depends on, with verified versions', () => {
    const section = recoverySection();

    // The in-place replacement, and the spot the loop filters tool calls from.
    expect(section).toContain('_replaceMessageInPlace');
    expect(section).toContain('agent-loop');
    // Pinned dev dependency and the installed runtime it was checked against.
    expect(section).toContain('pi-coding-agent@0.79.10');
    expect(section).toContain('1.5.0');
    // The early-warning tripwire for a future Pi upgrade.
    expect(section).toContain('leaked-tool-call.execution.test.ts');
  });

  it('names implementation files that exist next to this test', () => {
    const section = recoverySection();

    for (const file of [
      'leaked-tool-call.ts',
      'register-leaked-tool-call.ts',
      'leaked-tool-call.execution.test.ts',
    ]) {
      expect(section).toContain(file);
      expect(existsSync(join(HERE, file)), `${file} is documented but missing`).toBe(true);
    }
  });
});
