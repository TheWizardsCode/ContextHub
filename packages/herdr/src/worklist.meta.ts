/**
 * packages/herdr/src/worklist.meta.ts — metadata rows, the description
 * preview cache and the selection-list metadata panel content.
 *
 * Single responsibility: everything that turns a `WorkItem` into metadata
 * rows and metadata-panel lines — `buildMetaRows`, compound-row pairing
 * (`pairMetaRows`), the single module-level description preview cache with
 * its invalidation entry point, the unpadded panel content builder and its
 * height (`metadataPanelContentHeight`) that the state's `m`/`M` scroll clamp
 * uses. No list state, no keyboard/mouse handling. Imports types from
 * `fetcher.js` (type-only), the ANSI vocabulary from `worklist.constants.ts`
 * and formatting from `worklist.format.ts` (parent WL-0MVGKGD2Y0038S6B AC4 —
 * no barrel imports, no new cycles).
 *
 * Moved verbatim out of `worklist.ts` (parent WL-0MVGKGD2Y0038S6B; extraction
 * WL-0MVND6F9V004IQ3V). Move-only: no logic or rendered-output change.
 */

import type { BlockerRef, WorkItem } from './fetcher.js';
import {
  auditIcon,
  effortIcon,
  isCoveredByParent,
  needsProducerReviewIcon,
  priorityIcon,
  riskIcon,
  stageDisplayIcon,
  statusIcon,
} from '@worklog/shared/icons';
import { extractFilePaths } from './grouping.js';
import { renderMarkdown } from './md-viewer.js';
import { ANSI } from './worklist.constants.js';
import { formatTimestamp } from './worklist.format.js';

/**
 * Build the metadata table rows for a work item (label/value pairs).
 *
 * Includes every tracked field: ID, Title, Status, Stage, Priority, Type,
 * Risk, Effort, Children, Parent, Tags, GitHub Issue, Created, Updated,
 * Audit, and Audited At. When the item's `Key Files:` section
 * contains `.md` paths, a `Related Docs` row lists every one of them (joined
 * with `, `); the row is omitted when there are no `.md` Key Files
 * (WL-0MSGTLSUT002NF29). Fields that are unset are omitted.
 * Timestamps (Created, Updated, Audited At) are rendered in local time as
 * `DD/MM/YY HH:MM` via {@link formatTimestamp}.
 *
 * Icon-bearing fields (Status, Stage, Priority, Type, Risk, Effort, Audit)
 * render as **icon + text label**, using the same icon helpers as
 * the list rows (statusIcon, stageDisplayIcon, priorityIcon,
 * riskIcon, effortIcon, auditIcon) so the metadata
 * section and the list can never diverge (WL-0MSGIXHHI009KFW9). With icons
 * disabled the values fall back to plain text — the metadata deliberately
 * does NOT use the list's `[BRACKET]` fallbacks.
 * Shared by the detail view and the list-mode metadata panel so both stay
 * consistent (WL-0MSAYNVBY006LM9X-FT4).
 */
export function buildMetaRows(item: WorkItem, noIcons = false): Array<[string, string]> {
  const metaRows: Array<[string, string]> = [];
  const addMeta = (label: string, value: string | undefined | null): void => {
    if (value != null && value !== '') {
      metaRows.push([label, value]);
    }
  };
  // Log-derived dispatch rows (WL-0MUL2IY8L009S3PQ) that have no live `wl`
  // counterpart (`isLogOnly`) render an explicit `—` for priority/risk/effort
  // instead of silently dropping the row, so the panel never looks blank or
  // broken. A dispatch row ENRICHED from the live item (`mergeDispatchRow`)
  // leaves `isLogOnly` unset and renders exactly like any other live row
  // (WL-0MUGLL9SS002E1D2 audit fix).
  const addMetaOrDash = (label: string, value: string | undefined | null): void => {
    if (item.isLogOnly) {
      metaRows.push([label, value != null && value !== '' ? value : '—']);
    } else {
      addMeta(label, value);
    }
  };

  // Prefix a display value with its icon (`icon + text`, e.g. `🔄
  // in_progress`). Unknown icon keys return '' (e.g. free-form effort `3`),
  // so those rows stay text-only — consistent with the list
  // (WL-0MSGIXHHI009KFW9). When icons are disabled the icon is omitted
  // entirely: plain text only, no emoji, no [BRACKET] fallbacks.
  const iconText = (icon: string, text: string | undefined | null): string | undefined => {
    if (text == null || text === '') return undefined;
    return icon ? `${icon} ${text}` : text;
  };

  // Text labels paired with the Audit icons (AC5).
  const auditLabel = (result: boolean | null | undefined): string | undefined => {
    if (result === true) return 'ready to close';
    if (result === false) return 'not ready';
    return 'unknown';
  };
  const reviewLabel = (needsReview: boolean | undefined): string | undefined => {
    if (needsReview === undefined) return undefined;
    return needsReview ? 'needs review' : 'reviewed';
  };

  addMeta('ID', item.id);
  addMeta('Title', item.title);
  addMeta('Status', iconText(noIcons ? '' : statusIcon(item.status), item.status));
  // Stage mirrors the list's audit-aware in_review icon via the shared
  // stageDisplayIcon helper (AC2). A covered child's inherited parent-audit
  // symbol is dimmed to match the list row; the `Covered by` row that follows
  // names the covering parent so coverage is explicit and never silently
  // dropped (WL-0MUBVH8QG0020H9L AC3). The row is omitted when the parent's
  // audit state is unavailable (e.g. the detail view may not have the parent
  // loaded) — coverage is never guessed.
  const coveredByParent = isCoveredByParent(item, item.parentAudit);
  const stageGlyph = noIcons ? '' : stageDisplayIcon(item);
  addMeta(
    'Stage',
    noIcons
      ? item.stage
      : coveredByParent
        ? `${ANSI.dim}${stageGlyph}${ANSI.reset} ${item.stage}`
        : iconText(stageGlyph, item.stage),
  );
  if (coveredByParent && item.parentId) {
    addMeta('Covered by', item.parentId);
  }
  addMetaOrDash('Priority', iconText(noIcons ? '' : priorityIcon(item.priority), item.priority));
  // Type renders as plain text for every issue type — the `⊙` epic icon was
  // removed (WL-0MVAQ873D007LNWD); parent items are marked by the list's
  // expand arrow, so the indicator added no information.
  addMeta('Type', item.issueType);
  addMetaOrDash('Risk', iconText(noIcons ? '' : riskIcon(item.risk), item.risk));
  addMetaOrDash('Effort', iconText(noIcons ? '' : effortIcon(item.effort), item.effort));
  // Dispatch provenance for log-derived rows (WL-0MUL2IY8L009S3PQ).
  if (item.isLogDerived) {
    addMeta('Dispatch', item.dispatchKind);
    addMeta('Outcome', item.dispatchOutcome);
    addMeta('Dispatched', item.dispatchedAt ? formatTimestamp(item.dispatchedAt) : undefined);
  }
  addMeta('Children', item.childCount !== undefined ? String(item.childCount) : undefined);
  addMeta('Parent', item.parentId);
  if (item.tags && item.tags.length > 0) {
    metaRows.push(['Tags', item.tags.join(', ')]);
  }
  addMeta('GitHub Issue', item.githubIssueNumber ? `#${item.githubIssueNumber}` : undefined);
  addMeta('Created', item.createdAt ? formatTimestamp(item.createdAt) : undefined);
  addMeta('Updated', item.updatedAt ? formatTimestamp(item.updatedAt) : undefined);
  if (item.isLogOnly && item.auditResult == null) {
    // No live audit state on a log-only row — show `—` (WL-0MUL2IY8L009S3PQ).
    addMeta('Audit', '—');
  } else {
    addMeta('Audit', iconText(noIcons ? '' : auditIcon(item.auditResult), auditLabel(item.auditResult)));
  }
  addMeta('Audited At', item.auditedAt ? formatTimestamp(item.auditedAt) : undefined);

  // Producer-review row (restored WL-0MVAMS4RO000H3B0 F2): the flag drives a
  // `Reviewed` metadata row, mirroring the list-row ✓/✗ producer column so the
  // list and metadata can never diverge (WL-0MSGIXHHI009KFW9).
  addMeta('Reviewed', iconText(noIcons ? '' : needsProducerReviewIcon(item.needsProducerReview), reviewLabel(item.needsProducerReview)));

  // Related Docs — every .md path referenced in the item's `Key Files:`
  // section, joined with a compact delimiter so multi-file values fit the
  // existing label/value row format (WL-0MSGTLSUT002NF29). Display-only:
  // paths are shown as written in the description, no file I/O at render
  // time; resolution happens at open time via resolveKeyFilePath.
  const mdPaths = extractFilePaths(item.description ?? '').filter(p => p.endsWith('.md'));
  if (mdPaths.length > 0) {
    metaRows.push(['Related Docs', mdPaths.join(', ')]);
  }

  return metaRows;
}

// ── Compound metadata rows (WL-0MSNIX4V60012266) ──────────────────────────
// The four field pairs that should be rendered on a single compressed row.

/** Metadata field-pair definitions for compressed rendering. */
const META_ROW_PAIRS: Array<[string, string, string]> = [
  ['Status+Stage', 'Status', 'Stage'],
  ['Priority+Type', 'Priority', 'Type'],
  ['Created+Updated', 'Created', 'Updated'],
  ['Audit+AuditedAt', 'Audit', 'Audited At'],
] as const;

/**
 * Post-process `buildMetaRows` output to pair four field combinations onto
 * single rows, reducing the vertical space used in the metadata panel.
 *
 * Pairs: Status+Stage, Priority+Type, Created+Updated, Audit+AuditedAt.
 * Each pair is joined with ` / ` as a separator when BOTH values are
 * present. When only one half of a pair is present, the present half is
 * kept as its own single row (with its original label) so no field
 * information is ever lost (e.g. an item with an audit verdict but no
 * audited-at timestamp still shows its `Audit` row).
 *
 * All other rows pass through unchanged. The original row order is
 * preserved (pairs appear where their first component originally appeared).
 *
 * @param metaRows - Raw label/value pairs from {@link buildMetaRows}.
 * @returns A new array with the four pairs compressed into single rows.
 */
export function pairMetaRows(
  metaRows: Array<[string, string]>,
): Array<[string, string]> {
  const rows = new Map<string, string>(metaRows);
  const consumed = new Set<string>();

  const result: Array<[string, string]> = [];
  for (const [label, value] of metaRows) {
    // Second key of a pair already emitted inside a compound row — skip.
    if (consumed.has(label)) continue;

    // First key of a pair (buildMetaRows always emits the first key before
    // the second, so the compound row lands in its natural position).
    const pairDef = META_ROW_PAIRS.find(([, keyA]) => keyA === label);
    if (pairDef) {
      const [compoundLabel, keyA, keyB] = pairDef;
      const valA = rows.get(keyA);
      const valB = rows.get(keyB);
      if (valA != null && valB != null) {
        result.push([compoundLabel, `${valA} / ${valB}`]);
        consumed.add(keyB);
      } else {
        // Incomplete pair — keep the present half as a single row.
        result.push([label, value]);
      }
    } else {
      // Regular row, or the lone second key of an incomplete pair —
      // pass through unchanged.
      result.push([label, value]);
    }
  }

  return result;
}

// ── Description preview cache (WL-0MT9ZJF28004UJ28) ─────────────────────
// Cache key: `${itemId}|${descHash}|${maxCols}`. Stores FULL rendered markdown
// lines (no heading, no preview slicing) so the markdown parser — the
// expensive step — runs at most once per selection change per item; the
// per-call slicing to available panel space is cheap.
const descriptionPreviewCache = new Map<string, string[]>();

/**
 * Minimum number of description preview lines shown in the metadata panel
 * (rendered markdown lines, after the `Description` heading row).
 */
const DESCRIPTION_PREVIEW_MAX_LINES = 3;

/**
 * Simple djb2 hash for description strings — used as part of the cache key.
 * Collisions are harmless (cache miss triggers re-render); only correctness
 * and speed matter.
 */
function hashString(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Invalidate the description preview cache. Called on selection change
 * (cache reset per item) and item refresh (global clear).
 */
export function clearDescriptionPreviewCache(itemId?: string): void {
  if (itemId) {
    for (const key of descriptionPreviewCache.keys()) {
      if (key.startsWith(itemId + '|')) {
        descriptionPreviewCache.delete(key);
      }
    }
  } else {
    descriptionPreviewCache.clear();
  }
}

/**
 * Build the description preview lines for the metadata panel.
 *
 * Replaces the original raw-line preview with a markdown-aware version that
 * calls {@link renderMarkdown} from `md-viewer.ts`. Results are cached keyed
 * by (item.id, description hash) so the markdown parser runs at most once
 * per selection change (WL-0MT9ZJF28004UJ28 AC3).
 *
 * Returns up to `maxLines` rendered markdown lines from the item's
 * description, each truncated to `maxCols`. The preview starts with a dimmed
 * `Description` heading row. Returns an empty array when the description is
 * missing or blank.
 *
 * The preview fills the available panel space (AC2): `maxLines` is derived
 * from the remaining panel rows by the caller, clamped to a 3-row minimum
 * when other metadata lines are present.
 *
 * @param itemId - Work item ID (used for cache keying).
 * @param description - The work item's description text.
 * @param maxCols - Terminal width for truncation.
 * @param maxLines - Maximum rendered lines to show (floor 3 by default).
 * @returns Preview lines ready to insert into the metadata panel.
 */
function buildDescriptionPreview(
  itemId: string,
  description: string | undefined | null,
  maxCols: number,
  maxLines: number = DESCRIPTION_PREVIEW_MAX_LINES,
): string[] {
  if (!description || description.trim() === '') {
    return [];
  }

  const descHash = hashString(description);
  const renderKey = `${itemId}|${descHash}|${maxCols}`;

  // Reuse the fully rendered output across calls; slicing below is cheap.
  let rendered = descriptionPreviewCache.get(renderKey);
  if (!rendered) {
    rendered = renderMarkdown(description, maxCols);
    descriptionPreviewCache.set(renderKey, rendered);
  }

  const preview: string[] = [];
  // Heading row
  preview.push(` ${ANSI.dim}${ANSI.underline}Description${ANSI.reset}`);

  // Up to `maxLines` rendered markdown lines (the renderer already handles
  // wrapping/truncation, so lines are taken as-is)
  for (const line of rendered) {
    if (preview.length - 1 >= maxLines) break;
    preview.push(line);
  }

  return preview;
}

/**
 * Build the FULL, unpadded metadata-panel content lines for an item.
 *
 * Shared by {@link formatMetadataPanel} (which truncates, slices and pads
 * them to the panel viewport) and {@link metadataPanelContentHeight} (the
 * `m`/`M` scroll clamp), so the rendered window and the scroll clamp can
 * never diverge (WL-0MV8EZRDJ001TDA8).
 */
export function buildMetadataPanelLines(
  item: WorkItem,
  maxCols: number,
  panelRows: number,
  lastCommand?: string | null,
  noIcons = false,
  blockedBy?: BlockerRef[] | null,
): string[] {
  const lines: string[] = [];

  // Header separator identifying the selected item
  lines.push(` ${ANSI.dim}── ${item.id} ──${ANSI.reset}`);

  // Metadata rows — pair Status+Stage, Priority+Type, Created+Updated,
  // Audit+AuditedAt onto single rows for a more compact display (WL-0MSNIX4V60012266).
  // Drop the ID row since the panel header already shows the ID (WL-0MSHIJR7T007Q9R7).
  const metaRows = pairMetaRows(buildMetaRows(item, noIcons)).filter(([label]) => label !== 'ID');
  // Blocked By rows (WL-0MV8EZRDJ001TDA8) — one row per ACTIVE blocker, at
  // the END of the metadata section (after every field row, before the
  // description preview). ``${id} — ${title}`` keeps both readable; a
  // title-less blocker falls back to the bare ID rather than a dangling
  // separator. The blocker's status is appended as an icon + text suffix
  // when the edge carries one (WL-0MVBMLY2Z0032CYR). Omitted entirely when
  // there are no active blockers.
  for (const blocker of blockedBy ?? []) {
    if (!blocker || !blocker.id) continue;
    metaRows.push(['Blocked By', formatBlockerValue(blocker, noIcons)]);
  }
  if (metaRows.length > 0) {
    const fieldWidth = Math.max(...metaRows.map(([l]) => l.length), 6);
    for (const [label, value] of metaRows) {
      lines.push(` ${label.padEnd(fieldWidth)} ${value}`);
    }
  }

  // Description preview — markdown-rendered lines filling the available
  // panel space (WL-0MT9ZJF28004UJ28 AC2). The 3-row floor keeps a
  // meaningful preview on short panels; tall panels show more of the
  // description. A row is reserved for the Last command line (when the item
  // is being actively worked, i.e. status is in-progress) so it stays visible.
  // Cached per (id, description) so the markdown parser runs at most once per
  // selection change.
  const reserveLastCommand = item.status === 'in-progress' ? 1 : 0;
  const previewBudget = Math.max(DESCRIPTION_PREVIEW_MAX_LINES, panelRows - lines.length - reserveLastCommand);
  const preview = buildDescriptionPreview(item.id, item.description, maxCols, previewBudget);
  lines.push(...preview);

  // Last command — only meaningful while the item is being worked on
  if (item.status === 'in-progress') {
    if (lastCommand) {
      lines.push(` ${ANSI.dim}Last command: ${lastCommand}${ANSI.reset}`);
    } else {
      lines.push(` ${ANSI.dim}Last command: none yet${ANSI.reset}`);
    }
  }

  return lines;
}

/**
 * Format a single `Blocked By` row value (WL-0MVBMLY2Z0032CYR):
 * ``<id> — <title>`` with the blocker's status appended as an icon + text
 * suffix when the edge carries one (``<id> — <title> <icon> <status>``),
 * consistent with the Status/Stage/Priority row convention
 * (WL-0MSGIXHHI009KFW9). A title-less blocker falls back to the bare ID;
 * a status-less blocker renders ID (+ title) alone — the status suffix is
 * only appended when present. `noIcons` gates the emoji exactly like every
 * other meta row: icons disabled → plain text status only.
 */
export function formatBlockerValue(blocker: BlockerRef, noIcons: boolean): string {
  const base = blocker.title ? `${blocker.id} — ${blocker.title}` : blocker.id;
  const status = (blocker.status ?? '').trim();
  if (!status) return base;
  const icon = noIcons ? '' : statusIcon(status);
  return icon ? `${base} ${icon} ${status}` : `${base} ${status}`;
}

/**
 * Height (in lines) of the metadata panel's full content for `item` at
 * `panelRows` — the value the `m`/`M` scroll clamp subtracts the panel
 * height from (WL-0MV8EZRDJ001TDA8). Unlike {@link formatMetadataPanel}'s
 * return value (always exactly `panelRows` lines after padding), this is the
 * UNPADDED content length, so the scroll offset can reach the true bottom of
 * the panel.
 */
export function metadataPanelContentHeight(
  item: WorkItem | null,
  maxCols: number,
  panelRows: number,
  lastCommand?: string | null,
  noIcons = false,
  blockedBy?: BlockerRef[] | null,
): number {
  if (!item) return 0;
  return buildMetadataPanelLines(item, maxCols, panelRows, lastCommand, noIcons, blockedBy).length;
}
