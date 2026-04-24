/**
 * Shared dialog helper factories extracted from DialogsComponent.
 * These helpers provide stable defaults for creating blessed widgets used
 * by dialog UI code. They intentionally accept a blessed factory so
 * tests can provide lightweight doubles.
 */
import type { BlessedFactory, BlessedList, BlessedTextarea, BlessedBox } from '../types.js';
import { theme } from '../../theme.js';

/** Options accepted by the helper factories. This is intentionally loose to
 * mirror blessed's option shapes while keeping the helpers convenient to use.
 */
export type HelperOpts = Record<string, any>;

/**
 * Create a configured Blessed List with sensible defaults for dialogs.
 * @param blessed A blessed factory; defaults to global blessed when omitted.
 * @param opts Partial blessed list options; parent/position/items may be provided.
 * @returns BlessedList element configured with dialog-friendly defaults.
 */
export function createList(blessed: BlessedFactory | undefined, opts: HelperOpts = {}): BlessedList {
  // Allow calling signature createList(opts) by detecting first arg type.
  if (!opts && typeof blessed === 'object' && 'list' in (blessed as any)) {
    // blessed provided and opts omitted
  }
  const factory = (blessed as BlessedFactory) || (globalThis as any).blessed;
  const defaults = {
    keys: true,
    mouse: true,
    style: { selected: { bg: 'blue' } },
    items: [],
  } as any;
  return factory.list(Object.assign({}, defaults, opts)) as BlessedList;
}

/**
 * Create a configured Blessed Textarea with sensible defaults.
 * @param blessed A blessed factory; defaults to global blessed when omitted.
 * @param opts Partial blessed textarea options.
 * @returns BlessedTextarea element configured for dialog use.
 */
export function createTextarea(blessed: BlessedFactory | undefined, opts: HelperOpts = {}): BlessedTextarea {
  const factory = (blessed as BlessedFactory) || (globalThis as any).blessed;
  const defaults = {
    input: true,
    inputOnFocus: true,
    vi: true,
    wrap: true,
    keys: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    border: { type: 'line' },
    style: { fg: theme.tui.colors.lightText, bg: 'black', border: { fg: 'gray' } },
    scrollbar: { ch: ' ', inverse: true },
  } as any;
  return factory.textarea(Object.assign({}, defaults, opts)) as BlessedTextarea;
}

/**
 * Create a label box used as a section header inside dialogs.
 * @param blessed A blessed factory; defaults to global blessed when omitted.
 * @param opts Partial blessed box options.
 * @returns BlessedBox configured as a compact label.
 */
export function createLabel(blessed: BlessedFactory | undefined, opts: HelperOpts = {}): BlessedBox {
  const factory = (blessed as BlessedFactory) || (globalThis as any).blessed;
  const defaults = {
    height: 1,
    tags: false,
    style: { fg: 'cyan', bold: true },
  } as any;
  // Deep-merge style so callers can override individual style props without
  // discarding defaults like `bold`.
  const merged = Object.assign({}, defaults, opts);
  if (defaults.style && opts.style) {
    merged.style = Object.assign({}, defaults.style, opts.style);
  }
  return factory.box(merged) as BlessedBox;
}
