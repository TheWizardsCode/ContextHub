/**
 * packages/herdr/src/worklist.format.ts — display-width and timestamp
 * formatting helpers shared by every presentation module.
 *
 * Single responsibility: turn a line/timestamp into its display form —
 * `visibleLength` (terminal cell width), `truncateLine` (width-safe
 * truncation with an ellipsis), `formatTitleWithAssignee` (the shared
 * `[assignee] title` prefix) and `formatTimestamp` (`DD/MM/YY HH:MM`).
 * Leaf module: imports the ANSI vocabulary from `worklist.constants.ts` only
 * (parent WL-0MVGKGD2Y0038S6B AC4 — no barrel imports, no new cycles).
 *
 * Moved verbatim out of `worklist.ts` (parent WL-0MVGKGD2Y0038S6B; extraction
 * WL-0MVND6F9V004IQ3V). Move-only: no logic or output change.
 */

import { ANSI } from './worklist.constants.js';

/**
 * Ensure a line (possibly with ANSI codes) fits within the given width
 * by truncating and appending an ellipsis if necessary.
 */
/**
 * Compute the visual (terminal) width of a string, accounting for
 * multi-width characters that render as 2 cells.
 *
 * Characters in these Unicode ranges are known to be double-width
 * in most terminals:
 *   • U+2300–U+23FF  misc technical (⏳ etc.)
 *   • U+2600–U+26FF  miscellaneous symbols (⚠, ⛔)
 *   • U+1F000+       emoji (including supplementary-plane emoji)
 *   • U+3000–U+303F  CJK punctuation (ideographic space U+3000)
 *   • U+3400–U+4DBF  CJK Unified Ideographs Extension A
 *   • U+4E00–U+9FFF  CJK Unified Ideographs (core)
 *   • U+20000+       CJK Extension B+ (supplementary-plane)
 *   • U+AC00–U+D7AF  Hangul Syllables (Korean)
 *   • U+1100–U+11FF  Hangul Jamo
 *   • U+3130–U+318F  Hangul Compatibility Jamo
 *   • U+3100–U+312F  Bopomofo
 *   • U+31A0–U+31BF  Bopomofo Extended
 *   • U+FF01–U+FF5E  Fullwidth ASCII variants
 *   • U+FFA0–U+FFDC  Fullwidth Hangul
 *   • U+3200–U+32FF  Enclosed CJK
 *   • U+2460–U+24FF  Enclosed Alphanumeric
 */
export function visibleLength(s: string): number {
  let width = 0;
  for (let i = 0; i < s.length; i++) {
    // Handle surrogate pairs
    let cp: number;
    if (s.charCodeAt(i) >= 0xd800 && s.charCodeAt(i) < 0xdc00 && i + 1 < s.length) {
      cp = 0x10000 + ((s.charCodeAt(i) - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
      i += 1;
    } else {
      cp = s.charCodeAt(i);
    }
    // Double-width ranges: emoji, CJK, Hangul, fullwidth forms
    if (cp >= 0x2300 && cp < 0x2400) width += 2;            // ⏳ misc technical
    else if (cp >= 0x2600 && cp < 0x2700) width += 2;       // ⚠, ⛔ symbols
    else if (cp >= 0x1f000) width += 2;                      // emoji (incl. supplementary)
    else if (cp >= 0x3000 && cp < 0x3040) width += 2;       // CJK punctuation (ideographic space)
    else if (cp >= 0x3400 && cp < 0x4DC0) width += 2;       // CJK Extension A
    else if (cp >= 0x4E00 && cp < 0xA000) width += 2;       // CJK Unified Ideographs
    else if (cp >= 0x20000) width += 2;                      // CJK Extension B+
    else if (cp >= 0xAC00 && cp < 0xD800) width += 2;       // Hangul Syllables
    else if (cp >= 0x1100 && cp < 0x1200) width += 2;       // Hangul Jamo
    else if (cp >= 0x3130 && cp < 0x3190) width += 2;       // Hangul Compatibility Jamo
    else if (cp >= 0x3100 && cp < 0x3130) width += 2;       // Bopomofo
    else if (cp >= 0x31A0 && cp < 0x31C0) width += 2;       // Bopomofo Extended
    else if (cp >= 0xFF01 && cp < 0xFF5F) width += 2;       // Fullwidth ASCII
    else if (cp >= 0xFFA0 && cp < 0xFFDD) width += 2;       // Fullwidth Hangul
    else if (cp >= 0x3200 && cp < 0x3300) width += 2;       // Enclosed CJK
    else if (cp >= 0x2460 && cp < 0x2500) width += 2;       // Enclosed Alphanumeric
    else width += 1;
  }
  return width;
}

export function truncateLine(line: string, maxWidth: number): string {
  const visibleLen = visibleLength(line.replace(/\x1b\[[0-9;]*m/g, ''));
  if (visibleLen <= maxWidth) return line;

  let result = '';
  let visLen = 0;
  let i = 0;
  while (visLen < maxWidth - 1 && i < line.length) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i);
      if (end >= 0) {
        result += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    // Count visual width (multi-width chars add 2). Append the FULL
    // character (both surrogate halves) so truncation never leaves a lone
    // surrogate that would encode to U+FFFD (�) on write (WL-0MU3U1AMP0044WUX).
    let ch: string;
    let cp: number;
    if (line.charCodeAt(i) >= 0xd800 && line.charCodeAt(i) < 0xdc00 && i + 1 < line.length) {
      ch = line.slice(i, i + 2); // both halves of the surrogate pair
      cp = 0x10000 + ((line.charCodeAt(i) - 0xd800) << 10) + (line.charCodeAt(i + 1) - 0xdc00);
      i += 2;
    } else {
      ch = line[i];
      cp = line.charCodeAt(i);
      i += 1;
    }
    if (cp >= 0x2300 && cp < 0x2400) {
      visLen += 2; // ⏳ etc.
    } else if (cp >= 0x2600 && cp < 0x2700) {
      visLen += 2; // ⚠, ⛔
    } else if (cp >= 0x1f000) {
      visLen += 2; // emoji
    } else {
      visLen += 1;
    }
    result += ch;
  }
  // Close open ANSI and append ellipsis
  result += `${ANSI.reset}…`;
  return result;
}

/**
 * Format the title text for every title-bearing surface — selection-list
 * rows, the metadata panel's `Title` row, the detail-view header and the
 * hover tooltip (WL-0MVTPEB3A0091RDH AC2).
 *
 * An assigned item renders `[<assignee>] <title>` so a producer hold (`Map`)
 * or an active agent claim is visible at a glance without opening the item.
 * An unassigned item (undefined, null, empty or whitespace-only — assumption
 * A3) returns the title **byte-identically**, so every existing surface is
 * unchanged for unheld items (AC3). The assignee value itself is trimmed for
 * the prefix only; the `Assignee` metadata row keeps the raw stored value.
 *
 * The caller applies its own styling around the returned string, so the
 * prefix inherits the title's colour (AC4).
 */
export function formatTitleWithAssignee(title: string, assignee?: string | null): string {
  const holder = (assignee ?? '').trim();
  if (!holder) return title;
  return `[${holder}] ${title}`;
}

/**
 * Format an ISO-8601 timestamp for display as `DD/MM/YY HH:MM` in the
 * user's local time zone (zero-padded, 24-hour clock).
 *
 * Unparseable input is returned unchanged so a corrupt timestamp never
 * breaks rendering (WL-0MSF8HYUX0012WA9).
 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
