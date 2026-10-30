/**
 * packages/herdr/src/worklist.ts — Core work item list UI logic
 *
 * Provides the state model, rendering, and keyboard handling for the
 * Herdr work item selection list. This module is platform-independent
 * and has NO direct Herdr socket API dependency — it operates purely
 * on in-memory data and produces formatted string output.
 *
 * The design is inspired by the Pi TUI browse.ts but simplified for
 * Herdr's pane-based model.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { fetchChildrenForItem, fetchChildrenForItems, fetchActionableCount, fetchReviewQueueState, fetchItemsByStage, fetchItemsByPriority, fetchItemDetails, fetchBlockersForItem, getWorklogDir, getExecFileAsync, createInProcessRefreshScope, buildWlArgs, buildWlArgsForRoot, DEFAULT_WL_TIMEOUT_MS, type WorkItem, type ReviewQueueState, type BlockerRef } from './fetcher.js';
import { isPaneVisible, PollGate, DEFAULT_POLL_GATE_TTL_MS } from './visibility.js';
import { isAgentCommand } from './pane-title.js';
import { HerdrEventSubscriber } from './events.js';
import { AgentTracker } from './agent-tracker.js';
import { readCodeFreezeState, readCodeFreezeStatus, writeCodeFreezeMarker, clearCodeFreezeMarker } from './code-freeze.js';
import { runShipGuard, formatBlockedNotice } from './ship-guard.js';
import type { ShortcutRegistry, ShortcutEntry } from './shortcut-config.js';
import {
  stageColor,
  priorityIcon,
  riskIcon,
  effortIcon,
  getIconPrefixParts,
  isCoveredByParent,
  applyPriorityColour,
  ICON_LEGEND,
} from '@worklog/shared/icons';
import {
  runSync,
  heartbeatTtlForInterval,
  isSyncHeartbeatFresh,
  onSyncStatusChange,
  getSyncStatus,
  formatSyncNotice,
} from './auto-sync.js';
import { TaskScheduler, DEFAULT_SCHEDULER_TICK_MS } from './scheduler.js';
import { loadSettings } from './settings.js';
import {
  DbChangeTracker,
  resolveCacheDir,
  watchDbChanges,
  type DbChangeWatch,
  type WatchDbChangesOptions,
} from './db-change.js';
import { DEFAULT_DOWNTIME_POLL_INTERVAL_MS, DOWNTIME_RUN_TIMEOUT_MS, type DowntimeWorker } from './downtime-worker.js';
import { groupRecentDispatchesByTimeBlock, recentDispatchedItems } from './downtime-log.js';
import { buildDispatchWorkItem, mergeDispatchRow } from './dispatch-view.js';
import { resolveSprintViewWindow } from './browse-window.js';
import {
  assigneeHoldBannerText,
  assigneeHoldStatusText,
  summariseDispatchWindowHold,
  type DispatchWindowHoldSummary,
} from './dispatch-window-hold.js';
import {
  createHydratorRunner,
  createProductionHydratorDeps,
  HYDRATOR_INTERVAL_MS,
  HYDRATOR_RUN_TIMEOUT_MS,
} from './hydrator.js';
import { showToast } from './notify.js';
import { recordCommand, getLastCommand } from './command-log.js';
import {
  hasUnknownIdentifiers,
  getUnknownIdentifiers,
  FormState,
} from './form-dialog.js';
import { readFromClipboard, writeToClipboard } from './clipboard.js';
import { ShipItDialogState, overlayShipItDialog } from './ship-it-dialog.js';
import { KeypressDecoder } from './key-input.js';
import { extractFilePaths } from './grouping.js';
import { renderMarkdown } from './md-viewer.js';
import {
  findNoteInParagraph,
  insertNoteMarker,
  updateNoteMarker,
  removeNoteMarker,
  splitParagraphs,
  mapCursorToParagraph,
  mapParagraphToMarker,
  addNoteWithSync,
  resolveNoteWithSync,
  type NoteEditResult,
} from './md-note-edit.js';
import {
  ANSI,
  DOUBLE_CLICK_WINDOW_MS,
  DRAG_THRESHOLD_CELLS,
  PRIORITY_MAP,
  SHIP_IT_COMMAND,
  STAGES,
  STAGE_COLORS,
  STAGE_MAP,
  type Stage,
} from './worklist.constants.js';
import { computeMetadataPanelHeight, getTermSize } from './worklist.layout.js';
import type {
  ChordState,
  DisplayHeadingRow,
  ExecuteResult,
  HelpIconRow,
  KeyAction,
  MouseAction,
  MouseClickState,
  MouseDragState,
  NavigationStackEntry,
  NoteEditAction,
  ParsedMouseEvent,
  PodcastNotice,
  PodcastTargetResolution,
  ReviewQueueBannerState,
  TermSize,
  ViewMode,
} from './worklist.types.js';

// ── Barrel re-exports (WL-0MVND6DHH008R3LG): moved symbols still on the
// public surface; `PRIORITY_MAP`/`STAGE_COLORS` and `MIN_META_SHARE`/
// `MAX_META_SHARE` are internal to their modules (recorded-unused outside,
// parent AC2 — re-export only symbols consumers actually use) ──
export {
  ANSI,
  DOUBLE_CLICK_WINDOW_MS,
  DRAG_THRESHOLD_CELLS,
  SHIP_IT_COMMAND,
  STAGES,
  STAGE_MAP,
} from './worklist.constants.js';
export type { Stage } from './worklist.constants.js';
export { computeMetadataPanelHeight, getTermSize } from './worklist.layout.js';
export type {
  ChordState,
  DisplayHeadingRow,
  ExecuteResult,
  HelpIconRow,
  KeyAction,
  MouseAction,
  MouseClickState,
  MouseDragState,
  NavigationStackEntry,
  NoteEditAction,
  ParsedMouseEvent,
  PodcastNotice,
  PodcastTargetResolution,
  ReviewQueueBannerState,
  TermSize,
} from './worklist.types.js';

// ── Barrel re-exports (WL-0MVND6F9V004IQ3V): the state machine, the
// navigation/stage-filter helpers and the presentation leaf helpers the state
// machine depends on, moved to their own modules. Every symbol below is on the
// frozen consumer baseline (re-derived mechanically from the live import
// scan); the rest of each module stays internal. ──
export { createGatedTick, isHeadingRow, isInputActive, WorkItemListState } from './worklist.state.js';
export type { DisplayRow } from './worklist.state.js';
export { NavigationStack, StageFilter } from './worklist.navigation.js';
export {
  buildMetaRows,
  clearDescriptionPreviewCache,
  metadataPanelContentHeight,
  pairMetaRows,
} from './worklist.meta.js';
export { formatDetailContent, firstMarkdownKeyFile, renderFileViewer } from './worklist.detail.js';
export { formatTimestamp } from './worklist.format.js';

// ── Internal imports (WL-0MVND6F9V004IQ3V): symbols the barrel's own
// remaining code still calls, imported from the concrete sibling modules so
// the barrel never defines them twice. Not re-exported — unused outside. ──
import {
  WorkItemListState,
  createGatedTick,
  isHeadingRow,
  isInputActive,
} from './worklist.state.js';
import type { DisplayRow } from './worklist.state.js';
import { buildMetadataPanelLines } from './worklist.meta.js';
import {
  DETAIL_HEADER_LINES,
  formatDetailContent,
  formatDetailToC,
} from './worklist.detail.js';
import { formatTimestamp, formatTitleWithAssignee, truncateLine, visibleLength } from './worklist.format.js';

/**
 * Compute the dynamic list / metadata panel layout (WL-0MSQ44MDX008U69J).
 *
 * The selection list takes as much vertical space as its content needs, up to
 * the maximum available (pane rows minus the reserved notification row and the
 * metadata panel's minimum height).  The metadata panel fills whatever space
 * remains, expanding when the list is short.
 *
 * This function is called both by the renderer (createListRenderer) and by
 * the main TUI loop (to pass the panel height into metaScrollDown for
 * correct clamping).
 *
 * The display-rows model (WL-0MSL5MPSZ003TG94) passes `DisplayRow[]` —
 * heading rows are first-class rows already counted in the window, so no
 * extra separator accounting is needed.
 *
 * @param rows - Display rows (headings + items) to display.
 * @param scrollOffset - Current scroll offset into the display rows.
 * @param bannerCount - Number of code-freeze banner rows.
 * @param termSize - Terminal size.
 * @returns The metadata panel height, the list area, and the list height.
 */
export function computeDynamicLayout(
  rows: DisplayRow[],
  scrollOffset: number,
  bannerCount: number,
  termSize: TermSize,
): { panelHeight: number; listArea: number; listHeight: number } {
  const { rows: termRows } = termSize;
  const minMeta = 3;
  const chromeLines = 2 + bannerCount; // header + banners + footer

  // Estimate the visible window with metadata at its minimum so the estimate
  // reflects the list's true space need. Heading rows are already part of the
  // window — no separate separator count.
  const estListHeight = Math.max(3, termRows - 4 - minMeta);
  const estVisible = rows.slice(scrollOffset, scrollOffset + estListHeight);
  const estHasTopIndicator = scrollOffset > 0;
  const estHasBottomIndicator = scrollOffset + estVisible.length < rows.length;
  const estIndicatorRows = (estHasTopIndicator ? 1 : 0) + (estHasBottomIndicator ? 1 : 0);
  const contentNeed = estIndicatorRows + estVisible.length;

  const panelHeight = Math.max(minMeta, Math.max(0, termRows - 1 - contentNeed - chromeLines));
  const listArea = Math.max(1, termRows - 1 - panelHeight);
  // The initial visible window is the maximum possible (metadata at its
  // minimum); the caller's trimming logic reduces it to fit the actual
  // budget (fold indicators). This keeps the window generous so
  // a short list is never truncated just because the metadata panel expanded.
  const listHeight = Math.max(3, termRows - 4 - minMeta);
  return { panelHeight, listArea, listHeight };
}

// ── Formatting functions ──────────────────────────────────────────────

/**
 * Format a single item line for the list display.
 *
 * Includes icon prefix, stage colouring, and group markers.
 */
export function formatItemLine(
  item: WorkItem,
  maxCols: number,
  isSelected = false,
  noIcons = false,
): string {
  // Depth indentation for hierarchical display
  const depth = item.depth ?? 0;
  const depthIndent = depth > 0 ? '  '.repeat(depth) : '';

  // Expand/collapse icon — always 2 cells wide to keep alignment.
  // Items without children get 2 spaces so the icon prefix starts at the
  // same column regardless of whether the expand arrow is present.
  const expandIcon = item.childCount && item.childCount > 0
    ? (item._expanded ? '▼ ' : '▶ ')
    : '  ';

  const prefix = isSelected ? '▸ ' : '  ';
  // Derived child coverage (WL-0MUBVH8QG0020H9L): a child whose direct parent
  // has a fresh audit shows the parent's audit-result symbol. The shared,
  // dependency-free icon helper returns the plain glyph; the ANSI dim styling
  // is applied HERE, around the stage/audit icon only, so the prefix's
  // display-width alignment (computed on the plain string) is never corrupted
  // and other icons are not dimmed.
  const parts = getIconPrefixParts(item, { noIcons });
  let iconStr = parts.text;
  if (!noIcons && parts.stageEnd > parts.stageStart && isCoveredByParent(item, item.parentAudit)) {
    iconStr =
      parts.text.slice(0, parts.stageStart) +
      ANSI.dim +
      parts.text.slice(parts.stageStart, parts.stageEnd) +
      ANSI.reset +
      parts.text.slice(parts.stageEnd);
  }

  // Apply priority colouring to both title and ID (same colour). The title
  // carries the shared `[assignee] ` prefix (WL-0MVTPEB3A0091RDH AC2/AC4), so
  // the prefix inherits the title's priority colour.
  const colouredTitle = applyPriorityColour(formatTitleWithAssignee(item.title, item.assignee), item.priority);
  const priorityColouredId = applyPriorityColour(item.id, item.priority);

  const priorityStr = item.priority
    ? ` ${priorityIcon(item.priority, { noIcons })} ${item.priority}`
    : '';

  const stageTag = item.stage && item.status !== 'in-progress'
    ? ` [${item.stage}]`
    : '';

  // Log-derived dispatch rows (WL-0MUL2IY8L009S3PQ): annotate the list row
  // with the dispatch kind and latest pane-close outcome so an operator can
  // triage without opening the detail view. Live items never carry these
  // fields, so existing rows are unchanged.
  const dispatchTag = item.isLogDerived
    ? `${item.dispatchKind ? ` [${item.dispatchKind}]` : ''}${item.dispatchOutcome ? ` ${item.dispatchOutcome}` : ''}`
    : '';

  let line = `${depthIndent}${prefix}${expandIcon}${iconStr}${priorityColouredId} ${colouredTitle}${stageTag}${priorityStr}${dispatchTag}`;

  // Truncate to fit terminal width, accounting for ANSI codes and
  // multi-width characters (CJK, emoji, fullwidth forms). Reuses the
  // visibleLength() helper so characters like Chinese/Japanese/Korean
  // ideographs are counted as 2 terminal cells, preventing line-wrap
  // that would push the total rendered line count past rows-1
  // (WL-0MSNI6TQ5003JY1Z, WL-0MSAAON63003N6LO).
  const visLen = visibleLength(line.replace(/\x1b\[[0-9;]*m/g, ''));
  if (visLen > maxCols - 1) {
    // Truncate before ANSI codes, preserving them and counting
    // multi-width chars as 2 cells (truncateLine-compatible).
    let truncated = '';
    let charVisLen = 0;
    let i = 0;
    while (charVisLen < maxCols - 4 && i < line.length) {
      if (line[i] === '\x1b' && line[i + 1] === '[') {
        // Copy ANSI escape sequence
        const end = line.indexOf('m', i);
        if (end >= 0) {
          truncated += line.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      // Count visual width for multi-width characters. Appends the FULL
      // character (both surrogate halves for supplementary-plane emoji) so a
      // truncation point never leaves a lone surrogate — a lone surrogate
      // written to stdout encodes as U+FFFD (�) and renders as an "error"
      // glyph (WL-0MU3U1AMP0044WUX).
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
      if (cp >= 0x2300 && cp < 0x2400) charVisLen += 2;
      else if (cp >= 0x2600 && cp < 0x2700) charVisLen += 2;
      else if (cp >= 0x1f000) charVisLen += 2;
      else if (cp >= 0x3000 && cp < 0x3040) charVisLen += 2;
      else if (cp >= 0x3400 && cp < 0x4DC0) charVisLen += 2;
      else if (cp >= 0x4E00 && cp < 0xA000) charVisLen += 2;
      else if (cp >= 0x20000) charVisLen += 2;
      else if (cp >= 0xAC00 && cp < 0xD800) charVisLen += 2;
      else if (cp >= 0x1100 && cp < 0x1200) charVisLen += 2;
      else if (cp >= 0x3130 && cp < 0x3190) charVisLen += 2;
      else if (cp >= 0x3100 && cp < 0x3130) charVisLen += 2;
      else if (cp >= 0x31A0 && cp < 0x31C0) charVisLen += 2;
      else if (cp >= 0xFF01 && cp < 0xFF5F) charVisLen += 2;
      else if (cp >= 0xFFA0 && cp < 0xFFDD) charVisLen += 2;
      else if (cp >= 0x3200 && cp < 0x3300) charVisLen += 2;
      else if (cp >= 0x2460 && cp < 0x2500) charVisLen += 2;
      else charVisLen += 1;
      truncated += ch;
    }
    // Close any open ANSI codes before ellipsis
    truncated += `${ANSI.reset}…`;
    line = truncated;
  }

  return line;
}

/**
 * Wrap a row in reverse video for the selected-row highlight.
 *
 * Row content (item lines) can contain its own SGR colour segments, each
 * ending in a full `\x1b[0m` reset (priority-coloured ID/title,
 * WL-0MSJ2JFMO007PGQ6). A plain `reverse + line + reset` wrap lets those
 * interior resets clear the reverse attribute mid-row, so only the prefix
 * before the first coloured segment renders highlighted and the rest of the
 * row loses the selection bar. Re-assert reverse after every interior reset
 * so the WHOLE selected row stays highlighted; the trailing reset still
 * closes it. Lines without interior resets (heading rows) are unaffected.
 */
function reverseWrap(line: string): string {
  const reasserted = line.replace(/\x1b\[0m/g, `${ANSI.reset}${ANSI.reverse}`);
  return `${ANSI.reverse}${reasserted}${ANSI.reset}`;
}

// ── Hover tooltip rendering (WL-0MT9XRZDK006GMUH) ───────────────────

/**
 * Format a work-item hover tooltip line for an agent-pane row.
 *
 * Renders the 8 metadata fields: ID, Title, Command, Priority, Type,
 * Risk, Effort, and Start Time.
 *
 * @param item - The work item being hovered.
 * @param command - The command recorded for this pane (optional).
 * @param recordedAt - The ISO timestamp when the pane was recorded.
 * @param cols - Terminal width for truncation.
 * @param noIcons - Whether to skip icon rendering.
 * @returns Formatted tooltip lines.
 */
export function formatTooltipLines(
  item: WorkItem,
  command: string | undefined,
  recordedAt: string | undefined,
  cols: number,
  noIcons = false,
): string[] {
  // NOTE — `Blocked By` parity decision (WL-0MV8Q5X8U004KKAP AC-5): the
  // hover tooltip deliberately omits the blocker rows. Blockers are the
  // metadata panel's job (the SELECTED item's `Blocked By` rows in
  // `formatMetadataPanel`); the tooltip is a compact pane-status summary and
  // rendering its own async blocker lookup would duplicate the uncoordinated
  // async preview path whose flicker WL-0MV8Q5X8U004KKAP fixes. Kept
  // documented-out-of-scope rather than silently divergent.
  const parts: string[] = [];

  // ID + Title line. The title carries the shared `[assignee] ` prefix
  // (WL-0MVTPEB3A0091RDH AC2).
  const titleStr = item.title ? formatTitleWithAssignee(item.title, item.assignee) : '';
  parts.push(`${ANSI.bold}${item.id}${ANSI.reset} ${titleStr}`);

  // Command.
  if (command) {
    parts.push(`${ANSI.dim}Command:${ANSI.reset} ${ANSI.fg(220)}${command}${ANSI.reset}`);
  }

  // Priority + Type (compact row).
  const priorityStr = item.priority ? `${priorityIcon(item.priority, { noIcons })} ${item.priority}` : '';
  const typeStr = item.issueType ? `${item.issueType}` : '';
  const typeLabel = typeStr ? `${ANSI.dim}Type:${ANSI.reset} ${typeStr}` : '';
  const priorityLabel = priorityStr ? `${ANSI.dim}Priority:${ANSI.reset} ${priorityStr}` : '';
  if (priorityLabel && typeLabel) {
    parts.push(`${priorityLabel}${ANSI.dim}  ${typeLabel}${ANSI.reset}`);
  } else if (priorityLabel) {
    parts.push(priorityLabel);
  } else if (typeLabel) {
    parts.push(typeLabel);
  }

  // Risk + Effort (compact row).
  const riskStr = item.risk ? `${riskIcon(item.risk, { noIcons })} ${item.risk}` : '';
  const effortStr = item.effort ? `${effortIcon(item.effort, { noIcons })} ${item.effort}` : '';
  const riskLabel = riskStr ? `${ANSI.dim}Risk:${ANSI.reset} ${riskStr}` : '';
  const effortLabel = effortStr ? `${ANSI.dim}Effort:${ANSI.reset} ${effortStr}` : '';
  if (riskLabel && effortLabel) {
    parts.push(`${riskLabel}${ANSI.dim}  ${effortLabel}${ANSI.reset}`);
  } else if (riskLabel) {
    parts.push(riskLabel);
  } else if (effortLabel) {
    parts.push(effortLabel);
  }

  // Start Time.
  if (recordedAt) {
    parts.push(`${ANSI.dim}Started:${ANSI.reset} ${formatTimestamp(recordedAt)}`);
  }

  // Truncate each line to fit.
  return parts.map((line) => truncateLine(line, cols));
}

/**
 * Format the complete hover tooltip overlay as footer lines.
 *
 * The tooltip replaces the normal footer hints while a pane-associated row
 * is hovered and not dismissed. Each line is wrapped in a dark-grey box
 * so the overlay reads as a distinct panel.
 *
 * @param cols - Terminal width.
 * @param lines - Tooltip content lines from {@link formatTooltipLines}.
 * @returns Formatted footer lines for the tooltip; empty when no content.
 */
export function formatTooltipOverlay(cols: number, lines: string[]): string[] {
  if (lines.length === 0) return [];
  let maxWidth = 0;
  for (const line of lines) {
    const visibleLen = visibleLength(line.replace(/\x1b\[[0-9;]*m/g, ''));
    if (visibleLen > maxWidth) maxWidth = visibleLen;
  }
  const boxWidth = Math.min(Math.max(maxWidth + 2, 20), cols - 2);
  return lines.map((line) => {
    const visibleLen = visibleLength(line.replace(/\x1b\[[0-9;]*m/g, ''));
    const padding = Math.max(0, boxWidth - visibleLen);
    const bg = ANSI.bg(238);
    const fg = ANSI.fg(252);
    return `${ANSI.reset}${bg}${fg} ${line}${' '.repeat(padding)} ${ANSI.reset}`;
  });
}

/**
 * Format the metadata panel shown below the selection list.
 *
 * Renders the selected item's fields (via {@link buildMetaRows}) plus a
 * description preview (up to 3 lines) and a last command line when the item's
 * status is `in-progress`. The panel scrolls independently with its own offset:
 * when the content is taller than the panel,
 * `metaScrollOffset` selects the visible window and a `[m/M scroll]`
 * indicator is appended to the last line.
 *
 * @param item - Selected work item (or null for an empty panel).
 * @param maxCols - Terminal width (lines are truncated to fit).
 * @param panelRows - Number of rows available for the panel.
 * @param metaScrollOffset - Vertical scroll offset into the panel content.
 * @param lastCommand - Most recent command for the item (shown only when the
 *                      item status is `in-progress`).
 * @param noIcons - Icons gated off for this frame.
 * @param blockedBy - Active dependency blockers of the selected item
 *                    (WL-0MV8EZRDJ001TDA8). One `Blocked By` row is appended
 *                    per blocker, after the metadata rows and before the
 *                    description preview. Omitted entirely when empty, so an
 *                    unblocked item's panel is byte-for-byte unchanged.
 * @returns Exactly `panelRows` lines ready for the renderer.
 */
export function formatMetadataPanel(
  item: WorkItem | null,
  maxCols: number,
  panelRows: number,
  metaScrollOffset = 0,
  lastCommand?: string | null,
  noIcons = false,
  blockedBy?: BlockerRef[] | null,
): string[] {
  const lines: string[] = [];
  if (!item) {
    // Blank panel — pad to the full height
    while (lines.length < panelRows) {
      lines.push('');
    }
    return lines;
  }

  const content = buildMetadataPanelLines(item, maxCols, panelRows, lastCommand, noIcons, blockedBy);

  // Truncate to fit the terminal width
  for (let i = 0; i < content.length; i++) {
    if (content[i].length > 0) {
      content[i] = truncateLine(content[i], maxCols);
    }
  }

  // Apply independent scrolling
  const maxScroll = Math.max(0, content.length - panelRows);
  const safeOffset = Math.min(metaScrollOffset, maxScroll);
  const visible = content.slice(safeOffset, safeOffset + panelRows);

  // Scroll indicator when content overflows
  if (content.length > panelRows) {
    const percent = Math.round(((safeOffset + panelRows) / content.length) * 100);
    const indicator = ` ${ANSI.dim}[m/M scroll ${Math.min(percent, 100)}%]${ANSI.reset}`;
    visible[visible.length - 1] = truncateLine(visible[visible.length - 1] + indicator, maxCols);
  }

  // Pad to the panel height
  while (visible.length < panelRows) {
    visible.push('');
  }

  return visible;
}

/**
 * Resolve the metadata-panel Last-command line for the selected item
 * (WL-0MUY1CS9E006ZLS0).
 *
 * Only actively-worked items (`status === 'in-progress'`) expose their most
 * recent recorded command; every other item yields `undefined` so the panel
 * hides the line. This mirrors {@link formatMetadataPanel}'s status-based
 * reservation, so the looked-up command and the reserved row always agree.
 * Best effort: a missing or unreadable command log yields `undefined` and the
 * panel falls back to its graceful "none yet" placeholder.
 */
export function resolveMetaLastCommand(
  item: WorkItem | null | undefined,
): string | undefined {
  if (!item || item.status !== 'in-progress') return undefined;
  try {
    return getLastCommand(item.id)?.command ?? undefined;
  } catch {
    // ignore: panel shows the graceful "none yet" fallback
    return undefined;
  }
}

/**
 * Build the metadata-panel lines for a group heading selection
 * (WL-0MSL5MPSZ003TG94 T5 AC1). Headings have no work-item metadata, so the
 * panel shows the group's label, its item count (post stage-filter, as
 * computed by the display model), and the collapse state. A short hint line
 * tells the user Tab toggles the group.
 *
 * @param heading - The selected heading row.
 * @param maxCols - Terminal width.
 * @param panelRows - Panel height in rows (from the dynamic layout).
 * @returns The panel lines, padded to `panelRows`.
 */
export function formatGroupInfoPanel(
  heading: DisplayHeadingRow,
  maxCols: number,
  panelRows: number,
): string[] {
  const lines: string[] = [];

  // Header separator identifying the selected group
  lines.push(` ${ANSI.dim}── ${heading.groupLabel} ──${ANSI.reset}`);

  // Group metadata rows
  lines.push(` Label: ${heading.groupLabel}`);
  lines.push(` Items: ${heading.count}`);
  lines.push(` Group: ${heading.group}`);
  lines.push(` State: ${heading.collapsed ? 'collapsed' : 'expanded'}`);
  lines.push(` ${ANSI.dim}Tab toggles this group's collapse state${ANSI.reset}`);

  // Truncate to fit the terminal width
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      lines[i] = truncateLine(lines[i], maxCols);
    }
  }

  // Trim to the panel height and pad
  const visible = lines.slice(0, panelRows);
  while (visible.length < panelRows) {
    visible.push('');
  }
  return visible;
}

// ── Note-edit write-back (WL-0MSKV6SKK008MMXR) ────────────────────────

/**
 * Read a markdown file, apply an inline-note edit, and write it back.
 *
 * Pure with respect to the document text (via `md-note-edit.ts`): every
 * byte outside the edited paragraph is preserved.  The file reader/writer
 * are dependency-injected so the flow is side-effect-free and testable
 * (the viewer passes `readKeyFile` / a `writeKeyFile` bound to
 * `resolveKeyFilePath`).
 *
 * @param item - The work item whose Key Files carry the document.
 * @param mdPath - The Key Files path of the markdown document.
 * @param action - The edit to apply.
 * @param readFile - Reads the file content (path -> content or null).
 * @param writeFile - Persists the updated content (path, content).
 * @param episodeItems - Optional candidate episode work items (PRD §7.3
 *   note-child sync). When provided, inserts on a podcast script with a
 *   resolvable episode create a note child via `wl create --parent
 *   <episode>` and write the real note-child id into the marker (via
 *   `addNoteWithSync`); removes of a real (non-LOCAL) note id mark the
 *   marker `DONE` and post a resolution comment on the child (via
 *   `resolveNoteWithSync`). Omit (or pass []) for generic markdown — the
 *   local-only path never invokes `wl`.
 * @returns The edit result (doc, byteOffset, newNoteId for inserts).
 */
export async function applyNoteEditToFile(
  item: WorkItem | null,
  mdPath: string,
  action: NoteEditAction,
  readFile: (filePath: string) => string | null | Promise<string | null>,
  writeFile: (filePath: string, content: string) => void | Promise<void>,
  episodeItems?: WorkItem[],
): Promise<NoteEditResult> {
  if (!item) return { doc: '', byteOffset: -1 };
  const content = await readFile(mdPath);
  if (content == null) return { doc: '', byteOffset: -1 };

  let result: NoteEditResult;
  if (action.kind === 'insert') {
    if (episodeItems && episodeItems.length > 0) {
      // Podcast path: create the note child and write the real id (PRD
      // §7.3); unresolvable episode → LOCAL placeholder + warning.
      result = await addNoteWithSync(
        content,
        action.paragraphIndex ?? 0,
        action.text ?? '',
        episodeItems,
      );
    } else {
      // Generic markdown: local placeholder ids only — never invokes wl.
      result = insertNoteMarker(content, action.paragraphIndex ?? 0, action.text ?? '');
    }
  } else if (action.kind === 'update') {
    result = updateNoteMarker(content, action.noteId ?? '', {
      text: action.text ?? '',
      done: action.done,
    });
  } else if (action.kind === 'remove') {
    const noteId = action.noteId ?? '';
    const isLocal = noteId.startsWith('LOCAL-');
    if (episodeItems && episodeItems.length > 0 && noteId && !isLocal) {
      // Podcast delete/resolve: DONE marker + resolution comment on the
      // note child (PRD §7.3).
      result = await resolveNoteWithSync(
        content,
        noteId,
        action.text ?? 'Resolved via Herdr',
        episodeItems,
      );
    } else {
      result = removeNoteMarker(content, noteId);
    }
  } else {
    result = { doc: content, byteOffset: -1 };
  }
  if (result.byteOffset >= 0) {
    await writeFile(mdPath, result.doc);
  }
  return result;
}

/**
 * Build the candidate episode work items for PRD §7.3 note-child sync.
 *
 * The selected work item (an episode's Key Files include the script) plus
 * the loaded worklist items, deduplicated by id.  Used to resolve the
 * episode for a podcast script via `resolveEpisodeId`; generic markdown
 * yields an empty candidate set and stays local-only (never invokes `wl`).
 */
function buildEpisodeCandidates(state: WorkItemListState): WorkItem[] {
  const seen = new Set<string>();
  const candidates: WorkItem[] = [];
  const add = (item: WorkItem | null | undefined): void => {
    if (!item) return;
    if (seen.has(item.id)) return;
    seen.add(item.id);
    candidates.push(item);
  };
  add(state.detailItem);
  for (const item of state.getFlattenedItems()) {
    add(item);
  }
  return candidates;
}

/**
 * Resolve a `Key Files:` markdown path to an absolute filesystem path.
 *
 * Key Files paths are documented as relative to the worklog root, but the
 * plugin pane's process CWD is the plugin source directory — NOT the worklog
 * root — so resolving against `process.cwd()` alone is wrong
 * (WL-0MSGEA9AY0080V4Q). Candidates are tried in order:
 *
 * 1. the resolved worklog root (the directory containing `.worklog/`,
 *    derived from the configured worklog dir — see configureWorklogTarget /
 *    HERDR_RESOLVED_CWD),
 * 2. the legacy podcast-relative base `<root>/.llm-wiki/wiki/podcast/`
 *    (older episode items wrote Key Files paths relative to the podcast dir
 *    rather than the wiki root),
 * 3. `process.cwd()` as a last resort (plain CWD-relative key paths).
 *
 * Fail-open: returns null when no candidate exists on disk, so the detail
 * view falls back to the raw description.
 */
export function resolveKeyFilePath(filePath: string): string | null {
  const bases: string[] = [];
  const wlDir = getWorklogDir();
  if (wlDir) {
    const wlRoot = dirname(wlDir);
    bases.push(wlRoot);
    bases.push(join(wlRoot, '.llm-wiki', 'wiki', 'podcast'));
  }
  bases.push(process.cwd());
  for (const base of bases) {
    try {
      const candidate = resolvePath(base, filePath);
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore unreadable base and try the next candidate.
    }
  }
  return null;
}

/**
 * Format the detail view for a single work item, with scrolling support.
 *
 * @param item - The work item to display
 * @param maxCols - Terminal width
 * @param scrollOffset - Line offset to scroll the content
 * @param viewportHeight - Number of visible lines (default: terminal rows - 4)
 * @returns The rendered detail view string
 */

export function formatDetailView(
  item: WorkItem | null,
  maxCols: number,
  scrollOffset = 0,
  viewportHeight = 20,
  readFile?: (filePath: string) => string | null,
  noIcons = false,
  detailToCIndex = 0,
  detailToCFocus = true,
  detailRenderedIndex = 0,
  blockedBy?: BlockerRef[] | null,
): string {
  // The Related Docs ToC is pinned at the top of the detail view; only the
  // body below it scrolls (WL-0MSHWHULZ001FL8I).
  const tocLines = formatDetailToC(item, maxCols, detailToCIndex, detailToCFocus, noIcons);
  const allLines = formatDetailContent(item, maxCols, readFile, noIcons, detailToCIndex, detailToCFocus, detailRenderedIndex, blockedBy);
  if (allLines.length === 0) return '';

  const pinnedHeight = DETAIL_HEADER_LINES + tocLines.length;
  const bodyLines = allLines.slice(pinnedHeight);
  const bodyViewport = Math.max(1, viewportHeight - pinnedHeight);
  const totalBodyLines = bodyLines.length;
  const maxScroll = Math.max(0, totalBodyLines - bodyViewport);
  const safeOffset = Math.min(scrollOffset, maxScroll);

  const visible = [
    ...allLines.slice(0, pinnedHeight),
    ...bodyLines.slice(safeOffset, safeOffset + bodyViewport),
  ];

  // Add scroll indicator if the body is long
  if (totalBodyLines > bodyViewport && safeOffset <= maxScroll) {
    const percent = totalBodyLines > 0
      ? Math.round(((safeOffset + bodyViewport) / totalBodyLines) * 100)
      : 0;
    const scrollInfo = ` ${ANSI.dim}Lines ${safeOffset + 1}-${Math.min(safeOffset + bodyViewport, totalBodyLines)} of ${totalBodyLines} (${percent}%)  ` +
      `[↑↓/j:k scroll  g/G top/bot]${ANSI.reset}`;
    visible[visible.length - 1] = scrollInfo;
  }

  // Pad to fill viewport if less content
  while (visible.length < viewportHeight) {
    visible.push('');
  }

  return visible.join('\n');
}

/**
 * Format the filter selection prompt.
 */
export function formatFilterPrompt(maxCols: number): string {
  const options = STAGES.map((s, i) => {
    const color = STAGE_COLORS[s] || 241;
    return `${ANSI.fg(color)}[${i}] ${s}${ANSI.reset}`;
  }).join('  ');

  const lines = [
    '',
    ` ${ANSI.bold}Filter by stage:${ANSI.reset}`,
    ` ${options}`,
    '',
    ` ${ANSI.dim}[0-${STAGES.length - 1}] select stage  [esc] cancel${ANSI.reset}`,
  ];
  return lines.join('\n');
}

// ── Chord state helpers ───────────────────────────────────────────────

/**
 * Create an initial (empty) ChordState.
 */
export function createChordState(): ChordState {
  return {
    pendingKeys: [],
    hints: '',
    resolvedCommand: null,
    resolvedModel: null,
    resolvedOpenPane: undefined,
    resolvedFocus: undefined,
  };
}

/**
 * Check if a key matches any chord leader in the registry.
 */
export function isChordLeader(key: string, registry: ShortcutRegistry, codeFreezeActive?: boolean, issueType?: string): boolean {
  const chords = registry.getChordEntries(codeFreezeActive, issueType);
  return chords.some(c => {
    const chord = c.chord;
    return chord !== undefined && chord.length >= 1 && chord[0] === key;
  });
}

/**
 * Process a keypress when in chord mode.
 *
 * Returns 'chord-complete' if the chord resolved, 'chord-cancel' if the
 * key is invalid and the chord should be cancelled, or null if still
 * collecting keys.
 */
export function processChordInput(
  chordState: ChordState,
  key: string,
  registry: ShortcutRegistry,
  view: string,
  stage?: string,
  codeFreezeActive?: boolean,
  issueType?: string,
): 'chord-complete' | 'chord-cancel' | null {
  const pending = [...chordState.pendingKeys, key];

  // Check if this completes a chord
  const entry = registry.lookupChordEntry(pending, view, stage, codeFreezeActive, issueType);
  if (entry) {
    chordState.pendingKeys = [];
    chordState.hints = '';
    chordState.resolvedCommand = entry.command;
    chordState.resolvedModel = entry.model ?? null;
    // openPane is undefined when the entry did not set open_pane → the
    // dispatch defaults to opening a pane (WL-0MSJLD1I70045ZUL).
    chordState.resolvedOpenPane = entry.openPane ?? undefined;
    // focus is undefined/omitted when the entry did not set `focus` → no-focus
    // (current default); `true` defers the zoom toggle to the spawned pane
    // (WL-0MT70LC6B009TL3Q).
    chordState.resolvedFocus = entry.focus ?? undefined;
    return 'chord-complete';
  }

  // Check if this is a valid prefix for more chords
  const nextChords = registry.getChordByPrefix(pending, view, stage, codeFreezeActive, issueType);
  if (nextChords.length > 0) {
    chordState.pendingKeys = pending;
    // Update hints
    chordState.hints = formatChordHintsForHelp(nextChords, pending);
    return null; // Still collecting
  }

  // Invalid — cancel chord
  chordState.pendingKeys = [];
  chordState.hints = '';
  return 'chord-cancel';
}

/**
 * Build hint string for chord-mode display.
 *
 * Groups chords by next expected key and collapses multiple entries sharing
 * the same nextKey into a single `<key>:<firstWord>...` entry. Strips
 * consumed words from labels based on pending chord depth.
 *
 * @param chords - Chord entries to format (already filtered by prefix/view/stage)
 * @param pendingKeys - Current pending chord prefix
 * @returns Space-joined hint string, or empty string if no hints remain
 */
export function formatChordHintsForHelp(
  chords: ShortcutEntry[],
  pendingKeys: string[],
): string {
  const nextIdx = pendingKeys.length;

  type HintEntry = { nextKey: string; hint: string; firstRestWord: string };
  const hints: HintEntry[] = [];

  const extractLabel = (e: ShortcutEntry): string => {
    return e.label ?? e.command
      .replace(/<[^>]+>/g, '')
      .split(/\r?\n/)[0]
      .trim()
      .replace(/^\/(skill:)?/, '');
  };

  for (const c of chords) {
    const chord = c.chord;
    if (!chord || chord.length <= nextIdx) continue;

    const nextKey = chord[nextIdx];
    const label = extractLabel(c);
    const words = label.split(/\s+/);
    // Strip consumed words equal to pending chord depth
    const stripCount = Math.min(pendingKeys.length, Math.max(0, words.length - 1));
    const rest = words.slice(stripCount);
    const firstRestWord = rest.length > 0 ? rest[0] : (words.length > 0 ? words[words.length - 1] : '');
    const hint = rest.length > 0 ? `${nextKey}:${rest.join(' ')}` : nextKey;

    hints.push({ nextKey, hint, firstRestWord });
  }

  // Group by nextKey and collapse
  const byKey = new Map<string, HintEntry[]>();
  for (const h of hints) {
    const group = byKey.get(h.nextKey) ?? [];
    group.push(h);
    byKey.set(h.nextKey, group);
  }

  const result: string[] = [];
  for (const [, group] of byKey) {
    if (group.length > 1) {
      // Collapse: show first word with ellipsis
      result.push(`${group[0].nextKey}:${group[0].firstRestWord}...`);
    } else {
      result.push(group[0].hint);
    }
  }

  return result.join('  ');
}

/**
 * Literal footer advertisement for the help screen (WL-0MV85QZXN002T51A).
 *
 * `?` is a reserved key handled by the key loop, not a registry chord, so it
 * has no `shortcuts.json` entry to format. The hint is prepended to the
 * dynamic shortcut hints so it stays visible even when the footer is
 * truncated in a narrow pane. It replaces the retired `d:downtime toggle`
 * single-key advertisement and the `alt+m mouse on/off` suffix (parent
 * WL-0MTV97GV20088CS7): both bindings still work, only their inline
 * advertising moved to the help screen.
 */
export const HELP_FOOTER_HINT = '?: Help';

/**
 * Build the dynamic footer hint string for the visible shortcut entries.
 *
 * The `?: Help` advertisement is always prepended; the `d` single-key
 * downtime-toggle entry is no longer advertised (its binding is unchanged).
 *
 * @param entries - Shortcut entries already filtered by stage/view/issue type.
 * @returns Space-joined hint string (empty when no entry yields a hint).
 */
export function formatFooterShortcutHints(entries: ShortcutEntry[]): string {
  const labelOf = (e: ShortcutEntry): string => e.label ?? e.command
    .replace(/<[^>]+>/g, '')
    .split(/\r?\n/)[0]
    .trim()
    .replace(/^\/(skill:)?/, '');

  // Group multi-key chords by leader so a family is formatted as a unit.
  const grouped = new Map<string, ShortcutEntry[]>();
  const parts: string[] = [];
  for (const e of entries) {
    // Skip the d single-key downtime-toggle entry — only its advertisement
    // changes; the key binding remains in shortcuts.json (WL-0MV85QZXN002T51A).
    if (e.chord?.length === 1 && e.chord[0] === 'd') {
      continue;
    }
    if (e.chord && e.chord.length >= 2) {
      const leader = e.chord[0];
      const group = grouped.get(leader) ?? [];
      group.push(e);
      grouped.set(leader, group);
    } else if (e.chord && e.chord.length === 1) {
      parts.push(`${e.chord[0]}:${labelOf(e)}`);
    }
  }
  for (const [leader, group] of grouped) {
    const isTypeSpecific = group.every(
      e => e.workItemTypes !== undefined && e.workItemTypes.length > 0,
    );
    if (isTypeSpecific && group.length > 1) {
      // Distinct, type-gated progression steps: advertise each sub-option
      // (e.g. `w:write review...  w:write script...  w:write both...`).
      for (const e of group) {
        parts.push(`${leader}:${labelOf(e)}...`);
      }
    } else {
      // Homogeneous variant family: one collapsed leader hint as before.
      parts.push(`${leader}:${labelOf(group[0]).split(/\s+/)[0]}...`);
    }
  }
  // Advertise the help screen ahead of the dynamic hints (parent
  // WL-0MTV97GV20088CS7 AC1). The `d:downtime toggle` advertisement is
  // dropped above but its key binding is untouched.
  parts.unshift(HELP_FOOTER_HINT);
  return parts.join('  ');
}

/**
 * Word-wrap a single logical line into lines of at most `cols` display
 * cells, indenting continuation lines by `indent` columns. Keeps the FULL
 * text — never truncates — so a long description still reads completely and
 * the pane's physical row budget stays exact (producer audit on
 * WL-0MTV97GV20088CS7: "full (not truncated) descriptions").
 */
function wrapHelpLine(text: string, cols: number, indent: number): string[] {
  if (cols <= 1) return [text];
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const word of words) {
    const width = visibleLength(word);
    if (current === '') {
      current = word;
      currentWidth = width;
      continue;
    }
    if (currentWidth + 1 + width <= cols) {
      current += ` ${word}`;
      currentWidth += 1 + width;
    } else {
      lines.push(current);
      current = `${' '.repeat(indent)}${word}`;
      currentWidth = indent + width;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [text];
}

/**
 * Explicit group headings for chord-leader families whose member labels do
 * not share a common first word (so the derived heading would be a bare key).
 * Unknown leaders fall back to the label-derived heading in
 * {@link helpGroupHeading}, so future chords are still grouped.
 */
const HELP_LEADER_LABELS: Record<string, string> = {
  r: 'Review',
};

/**
 * Render a human-readable group heading for a chord-leader command family: the
 * leader key plus the shared first label word when a strict majority of the
 * group's labels agree (e.g. `c — create`, `a — audit`), else the bare leader
 * key (`r`). Derived from live registry data so future chords keep working.
 */
function helpGroupHeading(leader: string, group: ShortcutEntry[]): string {
  const explicit = HELP_LEADER_LABELS[leader];
  if (explicit) return `${leader} \u2014 ${explicit}`;
  const counts = new Map<string, number>();
  for (const e of group) {
    const word = (e.label ?? e.command).split(/\s+/)[0] ?? '';
    if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [word, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = word;
    }
  }
  if (bestCount > group.length / 2) {
    return `${leader} \u2014 ${best.charAt(0).toUpperCase()}${best.slice(1)}`;
  }
  return leader;
}

/** Human-readable heading for an icon category (e.g. `status` → `Status`). */
function helpCategoryHeading(category: string): string {
  return category
    .split('-')
    .map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Strip the leading category name from an icon meaning (the producer audit's
 * "remove the name prefix"): the group heading already names the category, so
 * `Status: open — not started` renders as `open — not started` under `Status`.
 * Meanings that do not start with the category label are returned unchanged.
 */
function helpMeaningWithoutCategory(category: string, meaning: string): string {
  const label = helpCategoryHeading(category);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Strip a leading `<Category>` optionally followed by a separator
  // (`:`, `—`, `–`, `-`) and/or whitespace. `Audit passed — …` under the
  // `Audit` heading becomes `passed — …`; unrelated meanings are untouched.
  const re = new RegExp(`^\\s*${escaped}\\s*[:\\u2014\\u2013-]?\\s*`, 'i');
  const stripped = meaning.replace(re, '').trim();
  return stripped.length > 0 ? stripped : meaning;
}

/** ANSI 256-colour code for the help-screen title (gold, WL-0MTV97GV20088CS7 rework). */
const HELP_TITLE_COLOUR = 220;
/** ANSI 256-colour code for the top-level section headings (Commands / Icons). */
const HELP_SECTION_COLOUR = 39;
/** ANSI 256-colour code for the command-family and icon-category sub-headings. */
const HELP_GROUP_COLOUR = 36;

/** Style a help-screen title line (bold + gold). */
function helpTitle(text: string): string {
  return `${ANSI.bold}${ANSI.fg(HELP_TITLE_COLOUR)}${text}${ANSI.reset}`;
}

/** Style a top-level help section heading (bold + blue). */
function helpSectionHeading(text: string): string {
  return `${ANSI.bold}${ANSI.fg(HELP_SECTION_COLOUR)}${text}${ANSI.reset}`;
}

/** Style a help sub-heading (command family / icon category, bold + cyan). */
function helpSubHeading(text: string): string {
  return `${ANSI.bold}${ANSI.fg(HELP_GROUP_COLOUR)}${text}${ANSI.reset}`;
}

/**
 * Render the full-pane `?` help overlay (WL-0MV85R14Y003RII9; layout reworked
 * per the producer audits of 2026-10-15 and 2026-10-16).
 *
 * Two sections are produced, each under a coloured heading:
 * - **Commands** — every supplied shortcut entry in a SINGLE column with its
 *   FULL (never truncated) description, grouped under a heading per chord
 *   leader family (`c — Create`, `a — Audit`, …) so groups are separated;
 * - **Icons** — the glyph legend (supplied by the caller from the shared icon
 *   source of truth), grouped by category under a heading (`Status`, `Stage`,…)
 *   with the category name prefix removed from each meaning and every group
 *   listed on a single line under its heading.
 *
 * Layout (2026-10-16 audit): sections and sub-headings are separated by blank
 * lines, and every heading level is coloured (title gold, section headings
 * blue, sub-headings cyan).
 *
 * The output honours the `rows - 1` render budget (matching the list
 * viewport contract, WL-0MTV979LK005YB1B): the title line and the dismiss
 * footer (`? / Esc / q`) are always shown, and the content between them is a
 * scrolling window at `scrollOffset`. When the full content is longer than
 * the budget the footer appends a scroll hint (`[↑↓/j:k scroll  g/G top/bot]`)
 * mirroring the detail view (WL-0MSHWHULZ001FL8I); further content is
 * revealed by scrolling.
 *
 * Display-only: it takes no state and mutates nothing.
 *
 * @param entries     - Shortcut entries filtered by stage/view/issue type.
 * @param cols        - Pane width in terminal cells.
 * @param rows        - Pane height in terminal cells.
 * @param iconRows    - Icon legend rows (empty when no legend is supplied).
 * @param scrollOffset - Vertical offset into the full content (clamped to the
 *                       last window; default 0 = top of the document).
 */
export function formatHelpScreen(
  entries: ShortcutEntry[],
  cols: number,
  rows: number,
  iconRows: ReadonlyArray<HelpIconRow> = [],
  scrollOffset = 0,
): string {
  const budget = Math.max(2, rows - 1);
  const title = helpTitle('Help');
  const footerBase = '? / Esc / q  close';
  // Title + footer are always reserved; the remainder is the scroll window.
  const contentBudget = Math.max(0, budget - 2);
  const lineWidth = Math.max(20, cols - 2);

  // ── Commands: single column, grouped by chord leader with headings ──
  const grouped = new Map<string, ShortcutEntry[]>();
  for (const e of entries) {
    const leader = (e.chord && e.chord.length > 0) ? e.chord[0] : '';
    const list = grouped.get(leader) ?? [];
    list.push(e);
    grouped.set(leader, list);
  }

  const content: string[] = [];
  // Leading blank: separates the pinned title from the first section heading
  // (2026-10-16 audit: "blank lines to separate the sections").
  content.push('');
  content.push(helpSectionHeading('Commands'));
  content.push('');
  for (const [leader, group] of grouped) {
    content.push(helpSubHeading(helpGroupHeading(leader, group)));
    for (const e of group) {
      const chord = (e.chord ?? []).join(' ');
      const label = e.label ?? e.command;
      const text = e.description
        ? `${chord}  ${label} \u2014 ${e.description}`
        : `${chord}  ${label}`;
      content.push(...wrapHelpLine(`  ${text}`, lineWidth, 6));
    }
    // A blank line separates each command family under the section.
    content.push('');
  }

  // ── Icons: grouped by category with a heading, one line per group ──
  if (iconRows.length > 0) {
    // The blank separator above already follows the last command family;
    // keep a clean exchange between the two top-level sections.
    content.push(helpSectionHeading('Icons'));
    content.push('');
    const byCategory = new Map<string, HelpIconRow[]>();
    for (const row of iconRows) {
      const list = byCategory.get(row.category) ?? [];
      list.push(row);
      byCategory.set(row.category, list);
    }
    for (const [category, rows] of byCategory) {
      content.push(helpSubHeading(helpCategoryHeading(category)));
      const tokens = rows
        .map(r => `${r.glyph} ${helpMeaningWithoutCategory(category, r.meaning)}`)
        .join('   ');
      content.push(...wrapHelpLine(`  ${tokens}`, lineWidth, 4));
      // A blank line separates each icon category under the section.
      content.push('');
    }
  }

  // ── Scroll window (2026-10-16 audit: "we need to be able to scroll") ──
  const maxScroll = Math.max(0, content.length - contentBudget);
  const safeOffset = Math.min(scrollOffset, maxScroll);
  const visible = content.slice(safeOffset, safeOffset + contentBudget);

  let footer = footerBase;
  if (maxScroll > 0) {
    const percent = content.length > 0
      ? Math.round(((safeOffset + contentBudget) / content.length) * 100)
      : 0;
    const hint = `${ANSI.dim}[↑↓/j:k scroll  g/G top/bot  ${Math.min(100, percent)}%]${ANSI.reset}`;
    // Keep the dismiss keys discoverable on narrow panes (WL-0MTV979LK005YB1B):
    // only append the scroll hint when the footer still fits the pane width.
    if (visibleLength(`${footerBase}   ${hint}`.replace(/\x1b\[[0-9;]*m/g, '')) <= cols) {
      footer = `${footerBase}   ${hint}`;
    }
  }

  const out = [title, ...visible];
  while (out.length < budget - 1) out.push('');
  out.push(footer);
  return out.slice(0, budget).join('\n');
}

/**
 * Get chord hints for showing in the help bar when in list mode.
 * Shows leader keys and abbreviated labels for all chords.
 */
export function getChordHelpHints(registry: ShortcutRegistry | undefined, codeFreezeActive?: boolean, issueType?: string): string {
  if (!registry) return '';
  const chords = registry.getChordEntries(codeFreezeActive, issueType);
  // Group by leader key
  const byLeader = new Map<string, string[]>();
  for (const c of chords) {
    const chord = c.chord;
    if (!chord || chord.length < 2) continue;
    const [leader] = chord;
    const label = c.label ?? c.command.replace(/<[^>]+>/g, '').split(/\r?\n/)[0].trim();
    const group = byLeader.get(leader) ?? [];
    group.push(`${leader}→${label.split(/\s+/)[0]}`);
    byLeader.set(leader, group);
  }
  if (byLeader.size === 0) return '';
  return ` [${[...byLeader.keys()].join('/')}] chords`;
}

// ── Keyboard handling ─────────────────────────────────────────────────

/**
 * Map special key sequences to action names.
 */
export function keyToAction(key: string): KeyAction {
  switch (key) {
    case '\x1b[A':
    case 'k':
      return 'up';
    case '\x1b[B':
    case 'j':
      return 'down';
    case '\x1b[5~':
    case '\x1b[V': // Some terminals send this for page up
      return 'pageup';
    case '\x1b[6~':
    case '\x1b[U': // Some terminals send this for page down
      return 'pagedown';
    case '\r':
    case '\n':
      return 'select';
    case '\t':
      return 'toggle-expand';
    case '\x1b':
      return 'back';
    // Ctrl+r (\x12) — immediate manual refresh of the selection list
    // (WL-0MV85T0LT008UT9H). The legacy bare-`r` refresh stays removed:
    // `r` is the Producer Review / Interview chord leader (WL-0MS4LDWHW0062FTA)
    // and is resolved via the ShortcutRegistry, not here. \x12 is not a chord
    // leader and not a single-key shortcut, so the existing
    // `action === 'refresh'` branch fires `doRefresh(true)`.
    case '\x12':
      return 'refresh';
    // '/' filter prompt removed — use f-* chords instead
    // 'r' is a single-key Producer Review shortcut — resolved via ShortcutRegistry
    // 'S' is the Ship It shortcut — resolved via ShortcutRegistry (opens the
    // typed-confirmation dialog, WL-0MSGG5N5Z0074TLY). The manual-sync 'S'
    // binding was removed; auto-sync on the timer is unaffected.
    case 'q':
      return 'quit';
    case 'g':
      return 'first';
    case 'G':
      return 'last';
    case 'm':
      return 'meta-down';
    case 'M':
      return 'meta-up';
    default:
      return null;
  }
}

/**
 * Handle a keypress in the current state. Returns the action performed
 * (or null if unrecognized).
 *
 * @param state - The current list state (mutated in place)
 * @param key - The raw keypress string
 * @param termSize - Current terminal dimensions
 * @param panelHeight - Dynamic metadata panel height (WL-0MSQ44MDX008U69J),
 *                      used to clamp m/M metadata scrolling; falls back to
 *                      the legacy fixed-height computation when omitted.
 * @returns The action string, or null if unhandled
 */
export function handleKeypress(
  state: WorkItemListState,
  key: string,
  termSize: TermSize,
  panelHeight?: number,
): KeyAction {
  if (state.mode === 'detail') {
    if (key === '\x1b' || key === 'q') {
      state.back();
      return 'back';
    }

    // Related Docs ToC navigation (WL-0MSHWHULZ001FL8I). When the item has
    // ≥1 .md Key File and keyboard focus is on the ToC (detailToCFocus),
    // j/k/arrows move the ToC selection; Enter renders the selected doc.
    // Navigating past the last entry transfers focus to document scrolling.
    const mdCount = state.detailItem
      ? extractFilePaths(state.detailItem.description ?? '').filter(p => p.endsWith('.md')).length
      : 0;
    const hasToC = mdCount > 0;

    if (hasToC && state.detailToCFocus) {
      if (key === 'j' || key === '\x1b[B') {
        if (state.detailToCIndex < mdCount - 1) {
          state.detailToCIndex += 1;
        } else {
          // Past the last entry → document scrolling focus
          state.detailToCFocus = false;
        }
        return null;
      }
      if (key === 'k' || key === '\x1b[A') {
        if (state.detailToCIndex > 0) {
          state.detailToCIndex -= 1;
        }
        return null;
      }
      if (key === '\r' || key === '\n') {
        // Enter renders the selected document in the md viewer
        state.detailRenderedIndex = state.detailToCIndex;
        return null;
      }
      if (key === 'g') {
        state.detailToCIndex = 0;
        return null;
      }
      if (key === 'G') {
        state.detailToCIndex = mdCount - 1;
        return null;
      }
      return null;
    }

    // Detail scrolling — when the item has a ToC this branch runs while
    // focus is on the document; k at the top of the document returns focus
    // to the ToC (WL-0MSHWHULZ001FL8I).
    if (key === 'j' || key === '\x1b[B') {
      state.detailScrollDown(1);
      return null;
    }
    if (key === 'k' || key === '\x1b[A') {
      if (hasToC && state.detailScrollOffset <= 0) {
        state.detailToCFocus = true;
      } else {
        state.detailScrollUp(1);
      }
      return null;
    }
    if (key === '\x1b[6~') {
      // Page down
      const pageSize = Math.max(5, termSize.rows - 4);
      state.detailScrollDown(pageSize);
      return null;
    }
    if (key === '\x1b[5~') {
      // Page up
      const pageSize = Math.max(5, termSize.rows - 4);
      state.detailScrollUp(pageSize);
      return null;
    }
    if (key === 'g') {
      state.detailScrollOffset = 0;
      return null;
    }
    if (key === 'G') {
      state.detailScrollOffset = 999999;
      return null;
    }
    return null;
  }

  if (state.mode === 'filter') {
    if (key === '\x1b') {
      state.back();
      return 'back';
    }
    // Digit keys select a stage by index
    const digit = parseInt(key, 10);
    if (!isNaN(digit) && digit >= 0 && digit < STAGES.length) {
      state.applyFilter(STAGES[digit]);
      return 'filter';
    }
    return null;
  }

  // List mode
  // Esc dismissal of a hover tooltip (WL-0MT9XRZDK006GMUH AC2): when the
  // tooltip is currently showing, Esc only dismisses it — the navigation
  // stack is never popped and the list selection is untouched. The tooltip
  // reappears on the next mouse re-entry over a pane-associated row.
  if (key === '\x1b' && state.hoveredRowIndex !== null && !state.tooltipDismissed) {
    state.hoveredRowIndex = null;
    state.tooltipDismissed = true;
    return 'dismiss-tooltip';
  }
  const action = keyToAction(key);
  switch (action) {
    case 'up':
      state.moveUp();
      break;
    case 'down':
      state.moveDown();
      break;
    case 'pageup':
      state.pageUp();
      break;
    case 'pagedown':
      state.pageDown();
      break;
    case 'select':
      if (state.mode === 'list' && state.selectedIndex >= 0) {
        const selected = state.getSelectedItem();
        // Toggle expand/collapse for items with actual children data at
        // ANY depth (WL-0MSQ3FH1K000MMJW): Enter on a child with children
        // expands it like a top-level parent, instead of opening the
        // detail view. Heading rows have no item (null) and fall through
        // to selectItem(), which is a no-op for headings.
        if (selected && selected.children && selected.children.length > 0) {
          if (state.isExpanded(selected.id)) {
            // Collapsing — remove the matching navigation-stack entry so
            // a later Escape does not pop back into a collapsed parent.
            state.clearNavigationStateFor(selected.id);
          } else {
            // Drilling down — save the current (parent) scroll/selection
            // state so Escape can return to it.
            state.pushNavigationState(selected.id);
          }
          state.toggleExpand(selected.id);
          return 'toggle-expand';
        }
      }
      state.selectItem();
      return 'select';
    case 'back':
      // If navigation stack is non-empty, pop to parent context
      if (!state.navigationStack.isEmpty && state.mode === 'list') {
        const entry = state.popNavigationState();
        if (entry) {
          // Collapse the parent we're returning to, so the view is clean
          if (state.isExpanded(entry.parentId)) {
            state.toggleExpand(entry.parentId);
          }
          return 'back';
        }
      }
      state.back();
      break;
    case 'filter':
      state.activateFilter();
      return 'filter';
    case 'refresh':
      return 'refresh';
    case 'quit':
      return 'quit';
    case 'first':
      state.goToFirst();
      break;
    case 'last':
      state.goToLast();
      break;
    case 'meta-down':
      // Scroll the metadata panel (independent of list navigation)
      state.metaScrollDown(1, panelHeight);
      break;
    case 'meta-up':
      state.metaScrollUp(1);
      break;
    case 'toggle-expand':
      if (state.mode === 'list' && state.selectedIndex >= 0 && state.items.length > 0) {
        const selected = state.getSelectedItem();
        if (selected) {
          // Any item with children — at ANY depth — can be expanded/
          // collapsed with Tab (WL-0MSQ3FH1K000MMJW). Children data is
          // fetched on demand by the caller when not yet loaded.
          if (selected.childCount && selected.childCount > 0) {
            // Track hierarchy: push parent state before expanding so Escape
            // can return to it; drop the entry when collapsing.
            if (state.isExpanded(selected.id)) {
              state.clearNavigationStateFor(selected.id);
            } else {
              state.pushNavigationState(selected.id);
            }
            // If children data already loaded, toggle inline
            if (selected.children && selected.children.length > 0) {
              state.toggleExpand(selected.id);
            }
            // Return action so caller can fetch children on demand
            return 'toggle-expand';
          }
        } else {
          // Heading row selected — Tab toggles that group's collapse state
          // (WL-0MSL5MPSZ003TG94 AC3). Handled inline (no on-demand fetch,
          // no navigation-stack churn); the heading row itself stays
          // visible so the group can be re-expanded.
          const row = state.getSelectedDisplayRow();
          if (row !== null && isHeadingRow(row)) {
            state.toggleGroupCollapse(row.group);
            state.clampSelection();
            return null;
          }
        }
      }
      return null;
  }
  return action;
}

// ── Mouse / touch input (WL-0MSGHM5BQ0096BNJ) ─────────────────────────
// SGR mouse-event parsing, split-chunk buffering, and click/wheel/filter
// row mapping for the selection list. Implements the contract pinned by the
// test-first suite packages/herdr/src/worklist-mouse.test.ts
// (WL-0MSI720DX002E9WC): ANSI mouseEnable/mouseDisable lifecycle constants
// (on the ANSI object), the pure SGR parser, the chunk consumer, and the
// state-aware action mapper.

/** Raw SGR mouse sequence: ESC [ < b ; x ; y M|m (M = press, m = release). */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** A plausible partial SGR body: the ESC prefix plus digits/semicolons only
 * (e.g. '\x1b[<0;10;') — still awaiting its terminating M/m. */
const SGR_PARTIAL_RE = /^\x1b\[<[0-9;]*$/;

/** Create a fresh drag state (helper for tests). */
export function createDragState(): MouseDragState {
  return {
    origin: null,
    accumulator: 0,
    active: false,
    prePressSelection: null,
    restored: false,
  };
}

/**
 * Parse a COMPLETE SGR mouse sequence ('\x1b[<b;x;yM' press or
 * '\x1b[<b;x;y m' release). Pure: returns null for any non-mouse input and
 * never buffers — split sequences are handled by {@link consumeMouseChunk}.
 */
export function parseMouseEvent(key: string): ParsedMouseEvent | null {
  const m = SGR_MOUSE_RE.exec(key);
  if (!m) return null;
  return {
    button: parseInt(m[1], 10),
    x: parseInt(m[2], 10),
    y: parseInt(m[3], 10),
    release: m[4] === 'm',
  };
}

/** Module-level buffer holding a partial SGR prefix across stdin chunks. */
let mouseChunkBuffer = '';

/**
 * Feed a stdin chunk to the SGR parser, holding a partial prefix
 * ('\x1b[<0;10;') in a module-level buffer until the terminating M/m
 * arrives in a later chunk (AC1 risk mitigation). Foreign escape sequences
 * (cursor moves, screen clears) leave a pending partial untouched; plain
 * input clears any stale pending partial so a stale tail can never complete
 * later.
 */
export function consumeMouseChunk(chunk: string): ParsedMouseEvent | null {
  if (chunk.startsWith('\x1b')) {
    // Escape-sequence chunk: a complete SGR parses and clears; a partial
    // SGR prefix starts buffering; any other control sequence is ignored.
    const complete = parseMouseEvent(chunk);
    if (complete) {
      mouseChunkBuffer = '';
      return complete;
    }
    if (mouseChunkBuffer === '' && SGR_PARTIAL_RE.test(chunk)) {
      mouseChunkBuffer = chunk;
    }
    return null;
  }
  // Non-escape chunk: the tail of a split sequence, or plain input.
  const combined = mouseChunkBuffer + chunk;
  const complete = parseMouseEvent(combined);
  if (complete) {
    mouseChunkBuffer = '';
    return complete;
  }
  if (SGR_PARTIAL_RE.test(combined)) {
    // Still a plausible partial body — keep buffering.
    mouseChunkBuffer = combined;
    return null;
  }
  // Plain input clears any stale pending partial.
  mouseChunkBuffer = '';
  return null;
}

/**
 * The list-mode row budget the renderer uses for the visible window — the
 * header, fold indicators, footer and metadata panel are chrome rows and
 * never map to display rows. Mirrors createListRenderer's window computation
 * so click mapping can never diverge from what is drawn.
 *
 * With the display-rows model (WL-0MSL5MPSZ003TG94) heading rows are
 * first-class rows in the window, so no extra separator accounting is needed.
 */
interface ListRowLayout {
  topIndicator: boolean;
  bottomIndicator: boolean;
  visibleStart: number;
  visibleCount: number;
}

function computeListRowLayout(state: WorkItemListState, termSize: TermSize): ListRowLayout {
  const displayRows = state.getDisplayRows();
  // Use dynamic layout with bannerCount=0 — this path is the mouse click
  // mapper and does not have the banner state; the layout is a close
  // approximation that keeps click mapping consistent with the renderer.
  const { listArea, listHeight } = computeDynamicLayout(
    displayRows,
    state.scrollOffset,
    /* bannerCount = */ 0,
    termSize,
  );
  const chromeLines = 2; // header + footer (no banners in this path)
  const budgetForRows = Math.max(0, listArea - chromeLines);

  let visible = displayRows.slice(state.scrollOffset, state.scrollOffset + listHeight);
  while (visible.length > 0 && visible.length > budgetForRows) {
    visible = visible.slice(0, -1);
  }
  const hasTopIndicator = state.scrollOffset > 0;
  const hasBottomIndicator = state.scrollOffset + visible.length < displayRows.length;
  const indicatorRows = (hasTopIndicator ? 1 : 0) + (hasBottomIndicator ? 1 : 0);
  const effectiveBudget = budgetForRows - indicatorRows;
  while (visible.length > 0 && visible.length > effectiveBudget) {
    visible = visible.slice(0, -1);
  }
  const bottomIndicator = state.scrollOffset + visible.length < displayRows.length;

  return {
    topIndicator: hasTopIndicator,
    bottomIndicator,
    visibleStart: state.scrollOffset,
    visibleCount: visible.length,
  };
}

/** Map a 1-based list row to the display-row index under it, or null when
 * the row is chrome (header, fold indicator, footer, panel). Heading rows
 * map to their own display-row index (they are selectable, WL-0MSL5MPSZ003TG94). */
function mapListRowToIndex(state: WorkItemListState, y: number, termSize: TermSize): number | null {
  if (y <= 1) return null; // header
  const displayRows = state.getDisplayRows();
  const { listArea } = computeDynamicLayout(
    displayRows,
    state.scrollOffset,
    /* bannerCount = */ 0,
    termSize,
  );
  if (y > 1 + listArea) return null; // footer, metadata panel, notification
  const layout = computeListRowLayout(state, termSize);
  let row = 2;
  if (layout.topIndicator) {
    if (y === 2) return null; // '▲ more'
    row = 3;
  }
  for (let i = 0; i < layout.visibleCount; i++) {
    if (y === row) return layout.visibleStart + i;
    row++;
  }
  return null; // '▼ more' or blank fill
}

/** Map a tapped column on the filter-prompt options row (y=3) to a stage
 * index — the option spans '[i] name' (AC5). */
function filterStageIndexForColumn(x: number): number | null {
  let col = 1; // leading space — '[i]' starts at column 2
  for (let i = 0; i < STAGES.length; i++) {
    const start = col + 1;
    const span = `[${i}] ${STAGES[i]}`.length;
    if (x >= start && x < start + span) return i;
    col += span + 2; // two-space separator
  }
  return null;
}

/**
 * Map a parsed SGR mouse event to a dispatchable action for the current
 * state. Gate rules (WL-0MSGHM5BQ0096BNJ AC2–AC6, WL-0MSI72S0Y0060BRK):
 * release events are inert; button-less motion (button & 32 and & 3 = 3)
 * drives the hover tooltip in list mode (left-button-held motion is a drag
 * candidate handled by {@link handleMouseInput} via {@link mapMouseDrag} —
 * it never returns a navigation/select action); wheel 64/65 navigate (list)
 * or scroll the detail (detail) and are ignored in filter mode; only the
 * left button selects; two left presses on the same row within
 * {@link DOUBLE_CLICK_WINDOW_MS} open the detail view (list mode) or go
 * back (detail mode); filter-mode taps on the stage-options row select a
 * stage.
 */
export function mapMouseToAction(
  state: WorkItemListState,
  ev: ParsedMouseEvent,
  termSize: TermSize,
  clickState?: MouseClickState,
): MouseAction {
  // Release events are consumed but inert — presses drive selection (AC6).
  if (ev.release) return null;
  // Motion events (button & 32): button-less motion triggers the hover
  // tooltip in list mode; left-button-held motion is handled separately
  // in handleMouseInput via mapMouseDrag (AC4).
  if ((ev.button & 32) !== 0 && (ev.button & 3) === 3) {
    // Button-less motion → hover tooltip (WL-0MT9XRZDK006GMUH).
    if (state.mode === 'list') {
      const index = mapListRowToIndex(state, ev.y, termSize);
      return index !== null ? { type: 'hover-row', index } : { type: 'hover-none' };
    }
    return null; // detail/filter: motion is inert
  }
  // Wheel buttons 64/65 (AC4).
  if (ev.button === 64) {
    if (state.mode === 'list') return { type: 'wheel-up' };
    if (state.mode === 'detail') return { type: 'scroll-detail-up' };
    return null; // filter mode: wheel ignored (plan A2)
  }
  if (ev.button === 65) {
    if (state.mode === 'list') return { type: 'wheel-down' };
    if (state.mode === 'detail') return { type: 'scroll-detail-down' };
    return null;
  }
  // Only the left button (0) selects/taps; middle/right are inert.
  if (ev.button !== 0) return null;

  // Double-click: same coordinates within DOUBLE_CLICK_WINDOW_MS (AC3,
  // inclusive boundary), mirroring the previous press.
  const isDoubleClick = clickState !== undefined
    && clickState.lastClick !== null
    && clickState.lastClick.x === ev.x
    && clickState.lastClick.y === ev.y
    && clickState.now - clickState.lastClick.at <= DOUBLE_CLICK_WINDOW_MS;

  if (isDoubleClick) {
    if (state.mode === 'detail') return { type: 'back' };
    if (state.mode === 'list') {
      const index = mapListRowToIndex(state, ev.y, termSize);
      // Repeated clicks on inert rows stay inert (AC3).
      return index !== null ? { type: 'open-detail' } : null;
    }
    // filter mode: fall through to the single-tap mapping below.
  }

  if (state.mode === 'detail') return null; // single clicks are inert
  if (state.mode === 'filter') {
    if (ev.y !== 3) return null; // AC5: only the options row is tappable
    const index = filterStageIndexForColumn(ev.x);
    return index !== null ? { type: 'filter-stage', index } : null;
  }
  const index = mapListRowToIndex(state, ev.y, termSize);
  return index !== null ? { type: 'select-row', index } : null;
}

/** Pure function that maps a drag candidate SGR mouse event to a drag
 * action, driven by the supplied `dragState` tracker.
 *
 * Behaviour (WL-0MSI72S0Y0060BRK):
 *
 *   - Left-button press: record origin + pre-press selection → `drag-start`
 *   - Left-button motion past `DRAG_THRESHOLD_CELLS`: return `drag-list`
 *     (list mode, whole-row deltas) or `drag-detail` (detail mode, lines)
 *   - Sub-threshold motion / release / filter mode / detail single-click: null
 *
 * Drag actions never emit `select-row` / `open-detail`; releases are inert.
 */
export function mapMouseDrag(
  state: WorkItemListState,
  ev: ParsedMouseEvent,
  dragState: MouseDragState,
  termSize: TermSize,
): MouseAction {
  // Filter mode and detail single-clicks: drag is out of scope (constraints).
  if (state.mode === 'filter') return null;

  // ── Left-button press: capture state and emit drag-start ─────────
  if (!ev.release && ev.button === 0) {
    dragState.origin = { x: ev.x, y: ev.y };
    dragState.accumulator = 0;
    dragState.active = false;
    dragState.restored = false;
    dragState.prePressSelection = {
      selectedIndex: state.selectedIndex,
      scrollOffset: state.scrollOffset,
    };
    return { type: 'drag-start' };
  }

  // ── Release: end the drag; return null (inert) ──────────────────
  if (ev.release) {
    dragState.origin = null;
    dragState.accumulator = 0;
    dragState.active = false;
    dragState.restored = false;
    dragState.prePressSelection = null;
    return null;
  }

  // ── Motion (left button held): compute deltas ───────────────────
  // Only process motion for the left button (button bits 0, with motion bit 32).
  // Other button+motion combos (e.g. middle+motion) are inert — fall through.
  if ((ev.button & 3) !== 0 || (ev.button & 32) === 0) {
    return null;
  }

  if (!dragState.origin) return null;

  const deltaY = ev.y - dragState.origin.y;

  if (state.mode === 'list') {
    // List mode: scroll proportional to vertical movement, snapped to whole
    // rows. A fractional accumulator converts continuous movement into
    // discrete row steps.
    dragState.accumulator += deltaY;
    let rows = 0;
    while (dragState.accumulator >= DRAG_THRESHOLD_CELLS) {
      dragState.accumulator -= DRAG_THRESHOLD_CELLS;
      rows++;
    }
    while (dragState.accumulator <= -DRAG_THRESHOLD_CELLS) {
      dragState.accumulator += DRAG_THRESHOLD_CELLS;
      rows--;
    }
    // Reset accumulator for next delta
    if (rows !== 0) {
      dragState.origin = { x: ev.x, y: ev.y };
      dragState.active = true;
    }
    return rows !== 0 ? { type: 'drag-list', rows } : null;
  }

  if (state.mode === 'detail') {
    // Detail mode: scroll proportional to vertical movement, 1 row ≈ 1 line.
    dragState.accumulator += deltaY;
    let lines = 0;
    while (dragState.accumulator >= DRAG_THRESHOLD_CELLS) {
      dragState.accumulator -= DRAG_THRESHOLD_CELLS;
      lines++;
    }
    while (dragState.accumulator <= -DRAG_THRESHOLD_CELLS) {
      dragState.accumulator += DRAG_THRESHOLD_CELLS;
      lines--;
    }
    if (lines !== 0) {
      dragState.origin = { x: ev.x, y: ev.y };
      dragState.active = true;
    }
    return lines !== 0 ? { type: 'drag-detail', lines } : null;
  }

  // Other modes (e.g. filter): drag is out of scope.
  return null;
}

/**
 * Wire a raw stdin chunk into the mouse path — the onData entry point
 * (WL-0MSGHM5BQ0096BNJ AC2–AC6, fix WL-0MSZBWT500034E74, WL-0MSI72S0Y0060BRK).
 * Parses SGR mouse events via {@link consumeMouseChunk}, maps them to an
 * action via {@link mapMouseToAction}, dispatches it against `state`
 * (mirroring the handleKeypress action handling), tracks the double-click
 * window in `clickState`, and drives drag-to-scroll via {@link mapMouseDrag}
 * with the accumulated `dragState`.
 *
 * Returns true when the chunk was mouse-shaped (fully consumed — it must
 * NOT reach the keyboard path); false for plain keys and foreign escape
 * sequences (arrows, etc.) so keyboard handling is untouched (AC6). A
 * partial SGR prefix is consumed (buffered) rather than leaked to the
 * keyboard path, per the split-chunk risk mitigation.
 *
 * Double-click ordering (fix): the clickState tracker is updated to the
 * current left-press AFTER mapMouseToAction runs, so the window compares
 * against the PRIOR press. Updating before the call made every click
 * self-match as a double-click (now - at === 0), opening detail instead of
 * selecting. Only left-button presses (not releases, wheel, or motion)
 * advance the tracker.
 */
export function handleMouseInput(
  state: WorkItemListState,
  key: string,
  termSize: TermSize,
  clickState: MouseClickState,
  dragState?: MouseDragState,
): boolean {
  const bufferBefore = mouseChunkBuffer;
  const mouseEvent = consumeMouseChunk(key);
  if (mouseEvent === null) {
    // Not a complete mouse event. An ESC chunk that matches the partial SGR
    // prefix, or a non-ESC chunk that touched a pending partial (grew or
    // cleared it), is mouse-shaped — consume it so a split sequence never
    // leaks into the keyboard path. Other input falls through to keys.
    if (key.startsWith('\x1b')) {
      return SGR_PARTIAL_RE.test(key);
    }
    return mouseChunkBuffer !== bufferBefore;
  }

  // Drag-state tracker — callers that only exercise click/wheel behaviour
  // may omit it; drag tracking then uses a fresh per-event tracker (no
  // cross-event state, so no drag can activate).
  const ds: MouseDragState = dragState ?? createDragState();

  // Current clock for the double-click window (Date.now; deterministic
  // tests inject clickState directly into mapMouseToAction instead).
  const now = Date.now();
  clickState.now = now;
  const action = mapMouseToAction(state, mouseEvent, termSize, clickState);

  // Advance the double-click tracker AFTER the double-click check — the next
  // event's window compares against THIS press (fix WL-0MSZBWT500034E74).
  if (!mouseEvent.release && mouseEvent.button === 0) {
    clickState.lastClick = { x: mouseEvent.x, y: mouseEvent.y, at: now };
  }

  // Update the drag-state tracker on every mouse event (press / motion /
  // release).  mapMouseDrag captures the pre-press selection and returns
  // the appropriate drag action (drag-start / drag-list / drag-detail) or
  // null for inert events.
  const dragAction = mapMouseDrag(state, mouseEvent, ds, termSize);

  if (action === null && dragAction === null) return true; // consumed but inert

  // Dispatch drag actions — they override regular mouse actions when the
  // drag mapper returns something (left-held motion in list/detail mode).
  if (dragAction !== null) {
    switch (dragAction.type) {
      case 'drag-start':
        // Bookkeeping only — mapMouseDrag already captured the pre-press
        // selection.  Fall through to the regular dispatch so the press
        // still selects (click behaviour preserved); a later threshold-
        // crossing motion restores the pre-press selection.
        break;
      case 'drag-list':
        // Restore the pre-press selection/scroll exactly once, on the first
        // threshold-crossing motion — a drag never leaves the selection
        // moved by the initial press (AC3).  Subsequent drag events
        // accumulate scroll on top of the restored state.
        if (!ds.restored && ds.prePressSelection) {
          state.selectedIndex = ds.prePressSelection.selectedIndex;
          state.scrollOffset = ds.prePressSelection.scrollOffset;
          ds.restored = true;
        }
        state.scrollBy(dragAction.rows);
        return true;
      case 'drag-detail':
        if (!ds.restored && ds.prePressSelection) {
          state.selectedIndex = ds.prePressSelection.selectedIndex;
          state.scrollOffset = ds.prePressSelection.scrollOffset;
          ds.restored = true;
        }
        if (state.detailItem) {
          dragAction.lines > 0
            ? state.detailScrollDown(dragAction.lines)
            : state.detailScrollUp(-dragAction.lines);
        }
        return true;
    }
  }

  if (action === null) return true; // consumed but inert

  // Dispatch mouse actions (mirrors the handleKeypress action handling).
  switch (action.type) {
    case 'select-row': {
      const rows = state.getDisplayRows();
      if (action.index >= 0 && action.index < rows.length) {
        state.selectedIndex = action.index;
      }
      break;
    }
    case 'open-detail': {
      const selected = state.getSelectedItem();
      if (selected) {
        // Toggle expand/collapse for items with actual children data.
        if (selected.children && selected.children.length > 0) {
          if (state.isExpanded(selected.id)) {
            state.clearNavigationStateFor(selected.id);
          } else {
            state.pushNavigationState(selected.id);
          }
          state.toggleExpand(selected.id);
        } else {
          state.selectItem();
        }
      }
      break;
    }
    case 'back':
      state.back();
      break;
    case 'wheel-up':
      state.moveUp();
      break;
    case 'wheel-down':
      state.moveDown();
      break;
    case 'scroll-detail-up':
      if (state.detailItem) state.detailScrollUp(1);
      break;
    case 'scroll-detail-down':
      if (state.detailItem) state.detailScrollDown(1);
      break;
    case 'filter-stage':
      if (action.index >= 0 && action.index < STAGES.length) {
        state.applyFilter(STAGES[action.index]);
      }
      break;
    case 'hover-row':
      // Update hovered row. The dismissed flag is intentionally NOT cleared
      // here (WL-0MT9XRZDK006GMUH AC2): after Esc, the tooltip stays hidden
      // while the pointer keeps moving within the rows area; only a
      // hover-none (pointer left the rows) clears the dismissal.
      state.hoveredRowIndex = action.index;
      break;
    case 'hover-none':
      // Pointer left the rows area — clear hover state and the dismissed
      // flag so a subsequent re-entry over a pane-row re-shows the tooltip.
      state.hoveredRowIndex = null;
      state.tooltipDismissed = false;
      break;
  }
  return true; // consumed a mouse event
}

// ── Renderer ──────────────────────────────────────────────────────────

/**
 * Create a list renderer function.
 *
 * Returns a function that produces the full screen content for the
 * current state. The caller should write this to stdout and handle
 * terminal setup/teardown.
 */
/**
 * Render the inline downtime-worker status fragment appended to the list
 * header (AC3, WL-0MSF49FMW009M06K): `[⏳ downtime idle m:ss]`,
 * `[downtime busy]`, `[⏳ downtime dispatching]`, `[Downtime Off]`,
 * `[Downtime Off (restored)]` (disable restored from the persisted marker,
 * WL-0MT5SG0VU005ARUR), or `[downtime paused]` (no-candidate cooldown,
 * WL-0MSI7DQL10016QYX).
 * `[downtime held: <token>]` (WL-0MU8808ZY0091JIA) shows the gate that
 * refused the last polled tick (e.g. `slot-owner`, `contention`,
 * `code-freeze`) so "idle slots but no dispatches" is visible instead of a
 * misleading idle label.
 * `[Downtime Off]` replaces the legacy `[downtime disabled]` text and is
 * shown whenever dispatch is off for the instance — either globally
 * settings-disabled or toggled off via the `d` shortcut (parent
 * WL-0MSZ4NSOE007AQEF). The rendered state ALWAYS agrees with the worker's
 * effective gate (override ?? settings); a disabled pane never shows the
 * enabled-idle string.
 * Inline-only — it never adds a row, so the pane-height budget is intact.
 */
export function renderDowntimeStatus(worker: DowntimeWorker | undefined): string {
  if (!worker) return '';
  if (worker.dispatching) {
    return ` ${ANSI.fg(208)}[⏳ downtime dispatching]${ANSI.reset}`;
  }
  if (!worker.enabled) {
    // Header honesty (WL-0MT5SG0VU005ARUR): a worker whose disable was
    // RESTORED from the persisted marker (.herdr-downtime-disabled) shows an
    // explicit notice so the restored-disabled state is never silent — the
    // operator always sees why this pane is off even after a restart.
    if (worker.restoredFromMarker) {
      return ` ${ANSI.dim}[Downtime Off (restored)]${ANSI.reset}`;
    }
    return ` ${ANSI.dim}[Downtime Off]${ANSI.reset}`;
  }
  if (worker.paused) {
    // No-candidate cooldown: the worker is not polling, so `idleSince` is
    // stale/empty — render the honest paused state instead of a stale idle
    // duration (AC6, WL-0MSI7DQL10016QYX).
    return ` ${ANSI.dim}[downtime paused]${ANSI.reset}`;
  }
  if (worker.blockReason) {
    // A gate refused the last polled tick (slot-owner / contention /
    // code-freeze / ...). Distinct from the idle label so the operator can
    // see WHY idle slots are not being used (WL-0MU8808ZY0091JIA AC4).
    return ` ${ANSI.fg(208)}[downtime held: ${worker.blockReason}]${ANSI.reset}`;
  }
  if (worker.idleSince !== null) {
    const elapsedSecs = Math.max(0, Math.floor((Date.now() - worker.idleSince) / 1000));
    const minutes = Math.floor(elapsedSecs / 60);
    const seconds = elapsedSecs % 60;
    return ` ${ANSI.fg(34)}[⏳ downtime idle ${minutes}:${String(seconds).padStart(2, '0')}]${ANSI.reset}`;
  }
  return ` ${ANSI.dim}[downtime busy]${ANSI.reset}`;
}

/**
 * Choose the review-queue-depth footer banner copy, or `null` when the banner
 * must not render (the queue is not deep).
 *
 * Copy (AH-0MUDYTQ55002NUSJ):
 *  - deep queue + an outstanding audit →
 *    `Review queue deep (<n> of <browseItemCount> completed/in_review) — focus on audits`;
 *  - deep queue + every root in_review item freshly audited →
 *    `Ready to Ship (shortcut 'S')`.
 *
 * Display-only: callers must NEVER gate downtime dispatch on this signal
 * (WL-0MTTSWC1X005P4VD). A fresh (current) audit of any result counts as
 * "not outstanding" — only a missing or non-current audit keeps "focus on
 * audits" (AC3).
 */
export function reviewQueueBannerText(state: ReviewQueueBannerState): string | null {
  if (!state.queueDeep) return null;
  if (!state.auditsOutstanding) return "Ready to Ship (shortcut 'S')";
  const countDisplay = state.browseItemCount !== undefined
    ? ` (${state.completedCount} of ${state.browseItemCount} completed/in_review)`
    : '';
  return `Review queue deep${countDisplay} — focus on audits`;
}

export function createListRenderer(getShowIcons?: () => boolean): (
  displayRows: DisplayRow[],
  selectedIndex: number,
  scrollOffset: number,
  termSize: TermSize,
  // Display label of the active filter (axis-qualified, e.g. `stage
  // in_review` or `priority critical`; WL-0MSKC8T46006999S) or null when
  // unfiltered. Rendered as `(filtered: <label>)` in the header. Callers
  // pass `state.activeFilterLabel`.
  activeFilter: string | null,
  mode: ViewMode,
  detailItem: WorkItem | null,
  totalCount?: number,
  chordState?: ChordState | null,
  detailScrollOffset?: number,
  /**
   * Retained for positional call-site compatibility only — the
   * `[auto-refresh on]` header indicator it drove was removed in
   * WL-0MV85T0LT008UT9H. Callers/tests pass it positionally; do not remove.
   */
  autoRefresh?: boolean,
  expandedItems?: Set<string>,
  chordHelpHints?: string,
  navStackDepth?: number,
  panePaused?: boolean,
  codeFreezeActive?: boolean,
  metaScrollOffset?: number,
  metaLastCommand?: string,
  readFile?: (filePath: string) => string | null,
  downtimeStatus?: string,
  detailToCIndex?: number,
  detailToCFocus?: boolean,
  detailRenderedIndex?: number,
  showHelpText?: boolean,
  codeFreezeAmbiguous?: boolean,
  hoverTooltip?: string[],
  /** When true, the review queue is deep (completed/in_review root items >= browseItemCount): display-only banner, NEVER auto-disables dispatch (WL-0MTTSWC1X005P4VD). */
  sprintComplete?: boolean,
  /** Number of completed+in_review items counted (used for the banner). (parent WL-0MTHSHN5V008R5L0) */
  sprintCompletedCount?: number,
  /** browseItemCount threshold for the review-queue-depth banner. (parent WL-0MTHSHN5V008R5L0) */
  browseItemCount?: number,
  /**
   * True when at least one root-level in_review item still has an outstanding
   * audit (no stored audit, or a non-current/stale audit). Drives the banner
   * copy: outstanding → "focus on audits"; none → "Ready to Ship".
   * (AH-0MUDYTQ55002NUSJ)
   */
  sprintAuditsOutstanding?: boolean,
  /** Active dependency blockers of the selected item, rendered as `Blocked By` rows (WL-0MV8EZRDJ001TDA8). */
  metaBlockedBy?: BlockerRef[] | null,
  /** Active dependency blockers of the detail item, rendered as `Blocked By` rows (WL-0MVBMLY2Z0032CYR). */
  detailBlockedBy?: BlockerRef[] | null,
  /** Non-blocking background-sync status notice appended to the header (F3 — WL-0MVJV2O7H003HY9N). */
  syncNotice?: string,
  /**
   * Header segment naming how many dispatch-window items are held by an
   * `assignee` (AC1, WL-0MVR8FN1D002SCIR): `[held: N by Map]`. Display-only;
   * absent/null renders nothing.
   */
  assigneeHoldStatus?: string | null,
  /**
   * Banner copy for a dispatch window held ENTIRELY by the `assignee`
   * scheduling hold (AC2, WL-0MVR8FN1D002SCIR). Display-only and read-only:
   * the banner never clears a hold or changes a dispatch decision. `null`
   * renders no banner (and consumes no chrome row).
   */
  assigneeHoldNotice?: string | null,
) => string {
  // Default to icons enabled when no getter is supplied (backwards
  // compatible — callers/tests that render without options keep icons).
  const showIconsGetter = getShowIcons ?? (() => true);
  return (
    displayRows: DisplayRow[],
    selectedIndex: number,
    scrollOffset: number,
    termSize: TermSize,
    activeFilter: string | null,
    mode: ViewMode,
    detailItem: WorkItem | null,
    totalCount?: number,
    chordState?: ChordState | null,
    detailScrollOffset?: number,
    /**
     * Retained for positional call-site compatibility only — the
     * `[auto-refresh on]` header indicator it drove was removed in
     * WL-0MV85T0LT008UT9H. Callers/tests pass it positionally; do not remove.
     */
    autoRefresh?: boolean,
    expandedItems?: Set<string>,
    chordHelpHints?: string,
    navStackDepth?: number,
    panePaused?: boolean,
    codeFreezeActive?: boolean,
    metaScrollOffset?: number,
    metaLastCommand?: string,
    readFile?: (filePath: string) => string | null,
    downtimeStatus?: string,
    detailToCIndex?: number,
    detailToCFocus?: boolean,
    detailRenderedIndex?: number,
    showHelpText?: boolean,
    codeFreezeAmbiguous?: boolean,
    hoverTooltip?: string[],
    sprintComplete?: boolean,
    sprintCompletedCount?: number,
    browseItemCount?: number,
    sprintAuditsOutstanding?: boolean,
    metaBlockedBy?: BlockerRef[] | null,
    /** Active dependency blockers of the detail item, rendered as `Blocked By` rows (WL-0MVBMLY2Z0032CYR). */
    detailBlockedBy?: BlockerRef[] | null,
    /** Non-blocking background-sync status notice appended to the header (F3 — WL-0MVJV2O7H003HY9N). */
    syncNotice?: string,
    /** Header segment for dispatch-window `assignee` holds (AC1, WL-0MVR8FN1D002SCIR). */
    assigneeHoldStatus?: string | null,
    /** Banner copy for an all-held dispatch window (AC2, WL-0MVR8FN1D002SCIR). */
    assigneeHoldNotice?: string | null,
  ): string => {
    const { rows, cols } = termSize;
    // Icons are gated by the getter for the whole frame (list lines, detail
    // view, and metadata panel alike) so showIcons=false omits every item
    // icon, including audit/review icons (AC1, WL-0MSBV4RYO008JL70).
    const noIcons = !showIconsGetter();
    const output: string[] = [];
    // Dynamic layout (WL-0MSQ44MDX008U69J): the selection list takes up to the
    // full available pane height; the metadata panel fills whatever space
    // remains, expanding when the list is short and sitting below the fold when
    // the list is long.  The metadata panel keeps a minimum of 3 rows (see
    // computeDynamicLayout).

    if (mode === 'detail' && detailItem) {
      const viewportHeight = Math.max(10, rows - 1);
      const offset = detailScrollOffset ?? 0;
      return formatDetailView(
        detailItem,
        cols,
        offset,
        viewportHeight,
        readFile,
        noIcons,
        detailToCIndex ?? 0,
        detailToCFocus ?? true,
        detailRenderedIndex ?? 0,
        detailBlockedBy,
      );
    }

    if (mode === 'filter') {
      // Show filter prompt
      const filterPrompt = formatFilterPrompt(cols);
      output.push(filterPrompt);
      // Pad remaining lines
      const remaining = rows - filterPrompt.split('\n').length;
      for (let i = 0; i < remaining; i++) {
        output.push('');
      }
      return output.join('\n');
    }

    // ── Render list mode ──────────────────────────────────────────

    // Header with total count. `totalItems` is
    // the count of WorkItem rows only (heading rows are excluded so the
    // header reconciles with per-group heading counts).
    // `autoRefresh` is intentionally unused since WL-0MV85T0LT008UT9H removed
    // the `[auto-refresh on]` header indicator; it is retained for
    // positional call-site compatibility (the production call site and many
    // tests pass it positionally). The setting still controls the scheduler
    // tick — the shortcut is independent of it.
    const totalItems = displayRows.filter((row) => !isHeadingRow(row)).length;
    const filterLabel = activeFilter ? ` (filtered: ${activeFilter})` : '';
    let header = ` ${ANSI.bold}Work Items${ANSI.reset} — ${totalItems} item(s)${filterLabel}`;
    if (totalCount !== undefined && totalCount > totalItems) {
      header += ` (top ${totalItems} of ${totalCount})`;
    }
    if (panePaused) {
      header += ` ${ANSI.fg(220)}[paused — hidden]${ANSI.reset}`;
    }
    if (downtimeStatus) {
      header += downtimeStatus;
    }
    // ── Assignee scheduling-hold indicator (AC1 — WL-0MVR8FN1D002SCIR) ──
    // Names how many dispatch-window items are held by a non-empty
    // `assignee` (the producer's scheduling hold). Display-only: it never
    // clears a hold and never changes a dispatch decision. The all-held
    // WARNING is a banner below (AC2); this segment reports the count even
    // when the window still has dispatchable work.
    if (assigneeHoldStatus) {
      header += ` ${ANSI.fg(220)}${assigneeHoldStatus}${ANSI.reset}`;
    }
    // ── Non-blocking sync notice (F3 — WL-0MVJV2O7H003HY9N) ─────
    // A tiny, render-only status notice ("⟳ syncing… Ns") while a background
    // `wl sync` is in flight. It NEVER blocks input: it is a pure string read
    // of the auto-sync status snapshot, appended to the header and clamped by
    // the same truncation guard as every other header segment. The notice is
    // the only "hanging" indication the operator sees — no spinner, no modal,
    // no lock wait.
    if (syncNotice) {
      header += ` ${ANSI.fg(45)}${syncNotice}${ANSI.reset}`;
    }
    // ── Header truncation guard (WL-0MSNI6TQ5003JY1Z) ────────────
    // In narrow panes the concatenated header can exceed `cols`,
    // causing the terminal to wrap it onto a second physical row.
    // That extra row shifts the entire output down and, when the
    // rendered line count exceeds `rows - 1` (WL-0MSAAON63003N6LO),
    // the first line scrolls off the top of the pane. Truncating
    // the header to exactly `cols` visible characters guarantees it
    // occupies one output row, preserving the `rows - 1` invariant
    // and keeping the header visible at row 0. ANSI styling is
    // preserved; trailing segments are dropped with an ellipsis.
    header = truncateLine(header, cols);
    output.push(header);

    // Code Freeze banners — a prominent warning that implementation is
    // blocked while a ship release is in progress (active marker), plus a
    // DISTINCT warning when the marker is ambiguous (unreadable file,
    // corrupt JSON, wrong shape): the downtime dispatcher treats ambiguity
    // as frozen (fail-closed), so the operator sees why implement/audit
    // dispatch is disabled (WL-0MSQ0RPQP00636JY). Each banner consumes one
    // chrome row (chromeLines accounts for them) so the `rows - 1` pane
    // line-count invariant still holds (WL-0MSAAON63003N6LO).
    let bannerCount = 0;
    if (codeFreezeActive) {
      const bannerText = `⛔ CODE FREEZE — ship release in progress; implement actions blocked`;
      const bannerLine = `${ANSI.bg(196)}${ANSI.fg(231)} ${bannerText} ${ANSI.reset}`;
      output.push(truncateLine(bannerLine, cols));
      bannerCount++;
    }
    if (codeFreezeAmbiguous) {
      const bannerText = `⚠ Ambiguous Codefreeze marker — implement/audit dispatch disabled`;
      const bannerLine = `${ANSI.bg(220)}${ANSI.fg(0)} ${bannerText} ${ANSI.reset}`;
      output.push(truncateLine(bannerLine, cols));
      bannerCount++;
    }
    // Assignee scheduling-hold banner (AC2 — WL-0MVR8FN1D002SCIR): a
    // dispatch window with ZERO dispatchable items solely because every item
    // carries a non-empty `assignee` (the producer sentinel `Map`, …). This
    // is a display-only WARNING — the hold is intentional and is never
    // auto-cleared; the operator just gets to tell "I parked this work on
    // purpose" apart from "the dispatcher is broken". Consumes one chrome
    // row so the `rows - 1` pane line-count invariant still holds
    // (WL-0MSAAON63003N6LO).
    if (assigneeHoldNotice) {
      const bannerText = `⚠ ${assigneeHoldNotice}`;
      const bannerLine = `${ANSI.bg(220)}${ANSI.fg(0)} ${bannerText} ${ANSI.reset}`;
      output.push(truncateLine(bannerLine, cols));
      bannerCount++;
    }

    // The caller passes the display-rows model (headings + items) — the
    // renderer renders exactly those rows and does NOT derive group
    // separators from group transitions (WL-0MSL5MPSZ003TG94 AC3).

    // Dynamic layout (WL-0MSQ44MDX008U69J): chrome rows already rendered are
    // header + banners.  Compute the list's content need from its rows, then
    // let the metadata panel fill whatever space remains (≥ 3-row minimum).
    const { panelHeight, listArea, listHeight } = computeDynamicLayout(
      displayRows,
      scrollOffset,
      bannerCount,
      termSize,
    );
    const chromeLines = 2 + bannerCount; // header + banners + footer

    // Heading rows are first-class rows in the display model, so the visible
    // window's row count already includes them — no separate separator
    // accounting (WL-0MSAAON63003N6LO keeps the `rows - 1` invariant).
    // The active stage filter is indicated in the header only (filterLabel)
    // — no standalone filter bar is rendered.
    const budgetForRows = Math.max(0, listArea - chromeLines);
    let visible = displayRows.slice(scrollOffset, scrollOffset + listHeight);
    while (visible.length > 0 && visible.length > budgetForRows) {
      // Drop trailing rows until the window fits the pane height.
      visible = visible.slice(0, -1);
    }

    // ── Fold indicators (WL-0MSG8YXYJ008PWJJ) ─────────────────────
    // Show dim `▲ more` / `▼ more` markers so users can tell the list
    // is scrolled or truncated.  Indicator rows consume budget so the
    // `rows - 1` invariant still holds.
    const hasTopIndicator = scrollOffset > 0;
    const hasBottomIndicator = scrollOffset + visible.length < displayRows.length;
    const indicatorRows = (hasTopIndicator ? 1 : 0) + (hasBottomIndicator ? 1 : 0);
    const effectiveBudget = budgetForRows - indicatorRows;
    while (visible.length > 0 && visible.length > effectiveBudget) {
      // Drop trailing rows until rows + indicators fit.
      visible = visible.slice(0, -1);
    }
    // Edge case: the trim may have made the list fully fit — the bottom
    // indicator is then omitted. This terminates in a single pass (no loop).
    const bottomIndicatorActive = scrollOffset + visible.length < displayRows.length;
    // Top indicator — first row of the items region when scrolled down.
    if (hasTopIndicator) {
      output.push(` ${ANSI.dim}▲ more${ANSI.reset}`);
    }
    let numHeadings = 0;
    for (let i = 0; i < visible.length; i++) {
      const actualIndex = scrollOffset + i;
      const row = visible[i];
      const isSelected = actualIndex === selectedIndex;

      // Heading row: render the label + item count + collapse arrow directly
      // from the display model (WL-0MSL5MPSZ003TG94 AC1/AC2).
      if (isHeadingRow(row)) {
        numHeadings++;
        const arrow = row.collapsed ? '▶' : '▼';
        const indent = (row.depth ?? 0) > 0 ? '  '.repeat(row.depth!) : '';
        // The In Review group is the only section with an active
        // producer-review obligation, so give its heading a grey ANSI 256
        // background to differentiate it from every other group heading
        // (WL-0MUYJ8WJG0087VSU). The label is sourced from grouping.ts
        // (`groupLabel: 'In Review'`), keeping that the single source of
        // truth. Dark grey 238 keeps sufficient contrast against the
        // existing yellow-ish heading foreground (stageColor(undefined) =
        // 220), so the foreground is intentionally left unchanged. All other
        // headings render exactly as before (no background escape).
        const headingBg = row.groupLabel === 'In Review' ? ANSI.bg(238) : '';
        const line = `${indent} ${headingBg}${ANSI.fg(stageColor(undefined))}${ANSI.bold}── ${row.groupLabel} (${row.count}) ${arrow} ──${ANSI.reset}`;
        output.push(isSelected ? reverseWrap(line) : line);
        continue;
      }

      // Item row: existing hierarchy + icon rendering.
      const item = row;
      const hasChildCount = item.childCount !== undefined && item.childCount > 0;
      const isExpanded = expandedItems?.has(item.id) ?? false;
      const expandedItem = { ...item, _expanded: hasChildCount && isExpanded };

      const line = formatItemLine(expandedItem, cols, isSelected, noIcons);
      if (isSelected) {
        output.push(reverseWrap(line));
      } else {
        output.push(line);
      }
    }

    // Bottom indicator — last row of the rows region when rows remain
    // below the fold (after the trimming edge case is resolved).
    if (bottomIndicatorActive) {
      output.push(` ${ANSI.dim}▼ more${ANSI.reset}`);
    }

    // Fill remaining rows (header + indicators + rows)
    const used = chromeLines + (hasTopIndicator ? 1 : 0) + (bottomIndicatorActive ? 1 : 0) + visible.length;
    for (let i = used; i < listArea; i++) {
      output.push('');
    }

    // Footer with keyboard hints (dynamic — includes chord hints if available).
    // Both the normal hint line and the chord-in-progress line are gated by
    // `showHelpText` (default true), so `showHelpText: false` hides ALL shortcut
    // hints, consistent with the pi browse widget's showHelpText handling
    // (WL-0MSGJDSMJ004128E). Note: gating only affects rendering — chord key
    // handling/accumulation in chordState continues regardless.
    //
    // ── Review-queue depth banner (display-only — WL-0MTTSWC1X005P4VD) ─
    // Replaces the help text footer when the root-only completed/in_review
    // count is at/over browseItemCount. Green background, white text. This is
    // a REVIEW-QUEUE DEPTH indicator (the producer's distinct "queue is deep"
    // signal) — it is display-only and NEVER disables dispatch: audits keep
    // draining the queue and check-ins continue (RCA root cause A). Copy is
    // chosen by `reviewQueueBannerText` (AH-0MUDYTQ55002NUSJ): while any root
    // in_review item still has an outstanding audit the banner says
    // `— focus on audits`; once every one has a current audit it says
    // `Ready to Ship (shortcut 'S')` (see `sprintAuditsOutstanding`). The former
    // "Sprint Complete, hit S to ship" copy was the queue-depth masquerade.
    // Only shown when help text is enabled (`showHelpText: true`); does NOT
    // interfere with code-freeze banners (those render above the list).
    const isSprintComplete = sprintComplete ?? false;
    const completedCount = sprintCompletedCount ?? 0;
    const helpEnabled = showHelpText ?? true;
    const bannerText = reviewQueueBannerText({
      queueDeep: isSprintComplete,
      completedCount,
      browseItemCount,
      auditsOutstanding: sprintAuditsOutstanding ?? false,
    });
    if (bannerText !== null && helpEnabled) {
      const bannerLine = `${ANSI.bg(40)}${ANSI.fg(255)} ${bannerText} ${ANSI.reset}`;
      output.push(truncateLine(bannerLine, cols));
    } else if (hoverTooltip && hoverTooltip.length > 0) {
      // Hover tooltip — replace the footer hints
      for (const line of formatTooltipOverlay(cols, hoverTooltip)) {
        output.push(line);
      }
    } else {
      const isChordActive = chordState && chordState.pendingKeys.length > 0;
      if (isChordActive && helpEnabled) {
        const pendingStr = chordState!.pendingKeys.join(' ');
        const hintStr = chordState!.hints
          ? `  ${ANSI.dim}${chordState!.hints}${ANSI.reset}`
          : '';
        const footerLine = ` ${ANSI.reverse} chord: ${pendingStr} _ ${ANSI.reset}${hintStr}`;
        output.push(truncateLine(footerLine, cols));
      } else {
        const navHint = (navStackDepth && navStackDepth > 0)
          ? ` ${ANSI.dim}[esc] back${navStackDepth > 1 ? ` (${navStackDepth} levels)` : ''}${ANSI.reset}`
          : '';
        // Gate the dynamic hint line behind showHelpText so `false` hides
        // the `?: Help` advertisement too, not only the chord-in-progress
        // footer (WL-0MV85QZXN002T51A AC3).
        const chordHelpSuffix = (helpEnabled && chordHelpHints)
          ? ` ${ANSI.fg(220)}${chordHelpHints}${ANSI.reset}`
          : '';
        const footerLine = navHint + chordHelpSuffix || ' ';
        // ── Footer wrap guard (WL-0MTV979LK005YB1B) ──────────────
        // In narrow panes the dynamic help line can exceed `cols`,
        // causing the terminal to wrap it onto a second physical row.
        // The safety clamp below counts array elements (logical rows),
        // not physical rows, so the wrapped footer pushed the header
        // off the top of the pane (mirrors the header guard,
        // WL-0MSNI6TQ5003JY1Z). Truncating to exactly `cols` visible
        // characters guarantees the footer occupies one output row
        // and preserves the `rows - 1` invariant.
        output.push(truncateLine(footerLine, cols));
      }
    }

    // ── Metadata panel ────────────────────────────────────────────
    // Reserve the bottom `panelHeight` rows for the selected row's
    // metadata (plus its last command when status is in-progress). The panel
    // has its own scroll offset (m/M) so long metadata never affects list
    // navigation (WL-0MSAYNVBY006LM9X). A heading selection has no item —
    // formatMetadataPanel renders a blank panel (group info lands here via
    // T5).
    const selectedRow = selectedIndex >= 0 && selectedIndex < displayRows.length
      ? displayRows[selectedIndex]
      : null;
    // Heading selection → group info panel (WL-0MSL5MPSZ003TG94 T5 AC1);
    // item selection → the normal metadata panel.
    const panelLines = selectedRow !== null && isHeadingRow(selectedRow)
      ? formatGroupInfoPanel(selectedRow, cols, panelHeight)
      : formatMetadataPanel(
          selectedRow,
          cols,
          panelHeight,
          metaScrollOffset ?? 0,
          metaLastCommand,
          noIcons,
          metaBlockedBy,
        );
    for (const line of panelLines) {
      output.push(line);
    }

    // Safety clamp: never exceed the renderer's `rows - 1` budget so the
    // notification line appended by render() always fits the pane. Only
    // triggers for pathological tiny term sizes where even the chrome rows
    // do not fit; the header (first line) is always preserved.
    while (output.length > rows - 1) {
      output.pop();
    }

    return output.join('\n');
  };
}

// ── Main TUI loop ─────────────────────────────────────────────────────

/**
 * Work-item ID format: a prefix (e.g. `WL`, `SA`) followed by a hash,
 * e.g. `WL-0MS9NPHQU005Y3VE`.
 */
const WORK_ITEM_ID_TOKEN = /^[A-Z]+-[\w-]+$/;

/**
 * Extract the last work-item ID token from a command string, if any.
 * Commands without an item ID (e.g. `echo hello`) return undefined and are
 * not recorded in the command log.
 */
export function extractWorkItemIdFromCommand(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (WORK_ITEM_ID_TOKEN.test(tokens[i])) {
      return tokens[i];
    }
  }
  return undefined;
}

/**
 * Record a command against its work item in the command log.
 *
 * Best effort: failures are swallowed so logging can never break command
 * dispatch. Commands without a work item ID are not recorded (only
 * plugin-dispatched commands with an item ID are logged).
 */
function logCommandForItem(command: string, itemId?: string): void {
  if (!itemId) return;
  try {
    recordCommand(itemId, command);
  } catch {
    // Logging must never break command routing
  }
}

/**
 * Invoke the resolved-command callback, forwarding the optional routing
 * flags with the strict "append only when explicitly set" arity rules shared
 * by every dispatch path:
 *
 *  - `openPane` is appended only when explicitly set (`false`); an undefined
 *    value keeps the 2-arg call byte-compatible so shortcuts without
 *    `open_pane` open a pane exactly as before (WL-0MSJLD1I70045ZUL).
 *  - `onRefresh` occupies the 4th slot and is forwarded when present so a
 *    background (no-pane) dispatch can refresh the list on child exit
 *    (WL-0MT1KB70U0012X6T).
 *  - `paneTitle` occupies the 5th slot; only pane-opening routes with a
 *    selected item carry one (WL-0MSJ4E8UA005KG9Y).
 *  - `focus` is appended as the 6th arg only when `true`, so callers
 *    without a focus flag see today's arity (WL-0MT70LC6B009TL3Q).
 *
 * Extracted so the placeholder form dialog honours `open_pane` /
 * `onRefresh` / `focus` exactly like the placeholder-free paths
 * (WL-0MV6J4HQ0009OJPQ).
 */
function invokeOnCommand(
  onCommand: (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string, focus?: boolean) => void,
  command: string,
  model: string | undefined,
  openPane: boolean | undefined,
  onRefresh: (() => Promise<void>) | undefined,
  paneTitle: string | undefined,
  focus: boolean | undefined,
): void {
  if (openPane === undefined) {
    if (paneTitle !== undefined) {
      if (focus === true) onCommand(command, model, undefined, undefined, paneTitle, true);
      else onCommand(command, model, undefined, undefined, paneTitle);
    } else {
      if (focus === true) onCommand(command, model, undefined, undefined, undefined, true);
      else onCommand(command, model);
    }
  } else if (onRefresh) {
    if (paneTitle !== undefined) {
      if (focus === true) onCommand(command, model, openPane, onRefresh, paneTitle, true);
      else onCommand(command, model, openPane, onRefresh, paneTitle);
    } else {
      if (focus === true) onCommand(command, model, openPane, onRefresh, undefined, true);
      else onCommand(command, model, openPane, onRefresh);
    }
  } else if (paneTitle !== undefined) {
    if (focus === true) onCommand(command, model, openPane, undefined, paneTitle, true);
    else onCommand(command, model, openPane, undefined, paneTitle);
  } else {
    if (focus === true) onCommand(command, model, openPane, undefined, undefined, true);
    else onCommand(command, model, openPane);
  }
}

/**
 * Resolve `<id>` placeholders in a command and route it through the
 * output mechanism. Used by {@link dispatchChordCommand} for agent
 * workflow and audit command families.
 *
 * The resolved command is recorded in the command log against its work
 * item BEFORE it is routed, so a downstream failure never skips the log
 * entry (WL-0MSEPP104006PS7T).
 *
 * @returns true if the command was resolved and routed, false if
 *          `<id>` was required but no item is selected (no-op)
 */
function resolveAndRouteCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string, focus?: boolean) => void,
  model?: string,
  openPane?: boolean,
  onRefresh?: () => Promise<void>,
  focus?: boolean,
): boolean {
  let resolvedCommand = command;
  let itemId: string | undefined;

  if (resolvedCommand.includes('<id>')) {
    const selected = state.getSelectedItem();
    if (selected) {
      resolvedCommand = resolvedCommand.replace(/<id>/g, selected.id);
      itemId = selected.id;
    } else {
      // No item selected and command requires <id> — graceful no-op
      return false;
    }
  } else {
    itemId = extractWorkItemIdFromCommand(resolvedCommand);
  }

  logCommandForItem(resolvedCommand, itemId);

  if (onCommand) {
    // Descriptive pane title (WL-0MSJ4E8UA005KG9Y): build it from the
    // selected/claimed work item IF resolvedCommand is an agent or shell
    // command that will open a pane; else undefined keeps current arity.
    const selected = state.getSelectedItem();
    const paneTitle =
      selected && (isAgentCommand(resolvedCommand) || resolvedCommand.startsWith('!'))
        ? selected.title
        : undefined;
    // Forward openPane/onRefresh/paneTitle/focus with the shared arity rules
    // (invokeOnCommand) so shortcuts without an explicit open_pane stay
    // byte-compatible (WL-0MSJLD1I70045ZUL, WL-0MT1KB70U0012X6T,
    // WL-0MT70LC6B009TL3Q).
    invokeOnCommand(onCommand, resolvedCommand, model, openPane, onRefresh, paneTitle, focus);
  }
  return true;
}

/**
 * Check whether a command starts an implementation workflow.
 *
 * Matches `/skill:implement`, `/skill:implement-single`, and
 * `/skill:implementall` (the implement command family). These are the
 * commands blocked while the project is in Code Freeze.
 */
export function isImplementCommand(command: string): boolean {
  const firstToken = command.trim().split(/\s+/)[0] ?? '';
  return firstToken.startsWith('/skill:implement');
}

/**
 * Render the Code Freeze notice dialog as a terminal overlay.
 *
 * Shown when the user issues an implement command while the project is in
 * Code Freeze. Informational only — no input fields; dismissed with Esc or
 * Enter, returning to the list without executing the command.
 *
 * @param maxCols - Terminal width
 * @param maxRows - Terminal height
 * @param reason - Optional freeze reason from the marker (e.g. "ship release")
 * @returns The rendered overlay string, ready for stdout
 */
export function formatCodeFreezeDialog(maxCols: number, maxRows: number, reason?: string): string {
  const lines: string[] = [];
  const dialogWidth = Math.min(maxCols - 4, 64);
  const dialogMinWidth = 44;
  const effectiveWidth = Math.max(dialogMinWidth, dialogWidth);
  const leftPad = Math.max(0, Math.floor((maxCols - effectiveWidth) / 2));

  const padLine = (content: string): string => {
    const visibleLen = visibleLength(content.replace(/\x1b\[[0-9;]*m/g, ''));
    const rightPad = Math.max(0, effectiveWidth - visibleLen - 2);
    return ' '.repeat(leftPad) + `│ ${content}${' '.repeat(rightPad)} │`;
  };

  const borderLine = (left: string, right: string): string => {
    return ' '.repeat(leftPad) + `${left}${'─'.repeat(effectiveWidth - 2)}${right}`;
  };

  lines.push('');
  lines.push(borderLine('┌', '┐'));

  // Title
  lines.push(padLine(`${ANSI.bold}${ANSI.fg(196)}⛔ CODE FREEZE${ANSI.reset}`));
  lines.push(padLine(''));

  // Body
  lines.push(padLine(` ${ANSI.bold}Implementation is blocked while a ship-it release${ANSI.reset}`));
  lines.push(padLine(` ${ANSI.bold}is in progress for this project.${ANSI.reset}`));
  lines.push(padLine(''));
  if (reason) {
    lines.push(padLine(` ${ANSI.dim}Reason: ${reason}${ANSI.reset}`));
    lines.push(padLine(''));
  }
  lines.push(padLine(` ${ANSI.dim}No agent pane was spawned and no work item was claimed.${ANSI.reset}`));
  lines.push(padLine(''));
  lines.push(padLine(` ${ANSI.dim}The freeze lifts automatically when the release finishes.${ANSI.reset}`));
  lines.push(padLine(''));

  lines.push(borderLine('├', '┤'));
  lines.push(padLine(''));
  lines.push(padLine(`${ANSI.dim}[Esc] dismiss  [Enter] dismiss${ANSI.reset}`));
  lines.push(borderLine('└', '┘'));
  lines.push('');

  const totalLines = lines.length;
  const remaining = Math.max(0, maxRows - totalLines);
  for (let i = 0; i < remaining; i++) {
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render a full-pane, dismissable modal notice: a centred box with a bold
 * accent-coloured title, a body, and a dim dismiss-key footer.
 *
 * Extracted from {@link formatBlockedShipDialog} so the Ship-mode blocked
 * notice and the podcast w-chord dispatch notice (OSL-0MUQ59IRF009ICIF)
 * share one implementation and render identically apart from title/accent.
 *
 * @param maxCols - Terminal width.
 * @param maxRows - Terminal height (the box is padded to fill it).
 * @param title - Bold title line (rendered in the accent colour).
 * @param body - Body text; `\n` is honoured and each line is padded.
 * @param accent - ANSI 256-colour code for the title.
 */
export function formatNoticeDialog(
  maxCols: number,
  maxRows: number,
  title: string,
  body: string,
  accent: number,
): string {
  const lines: string[] = [];
  const dialogWidth = Math.min(maxCols - 4, 76);
  const effectiveWidth = Math.max(52, dialogWidth);
  const leftPad = Math.max(0, Math.floor((maxCols - effectiveWidth) / 2));

  const padLine = (content: string): string => {
    const visibleLen = visibleLength(content.replace(/\x1b\[[0-9;]*m/g, ''));
    const rightPad = Math.max(0, effectiveWidth - visibleLen - 2);
    return ' '.repeat(leftPad) + `│ ${content}${' '.repeat(rightPad)} │`;
  };

  const borderLine = (left: string, right: string): string =>
    ' '.repeat(leftPad) + `${left}${'─'.repeat(effectiveWidth - 2)}${right}`;

  lines.push('');
  lines.push(borderLine('┌', '┐'));
  lines.push(padLine(`${ANSI.bold}${ANSI.fg(accent)}${title}${ANSI.reset}`));
  lines.push(padLine(''));
  for (const raw of body.split('\n')) {
    lines.push(padLine(raw));
  }
  lines.push(padLine(''));
  lines.push(borderLine('├', '┤'));
  lines.push(padLine(`${ANSI.dim}[Esc] dismiss  [Enter] dismiss  [q] dismiss${ANSI.reset}`));
  lines.push(borderLine('└', '┘'));
  lines.push('');

  const remaining = Math.max(0, maxRows - lines.length);
  for (let i = 0; i < remaining; i++) {
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render the persistent, dismissable notice for a podcast w-chord dispatch
 * attempt (OSL-0MUQ59IRF009ICIF).
 *
 * The w-chords' failure and confirmation feedback used to be transient
 * fire-and-forget `herdr notification` toasts that were easy to miss — the
 * reported symptom was "nothing happens". This notice stays on screen until
 * the operator dismisses it, so a refused dispatch can never be mistaken for
 * a silently dropped keypress.
 */
export function formatPodcastNotice(
  maxCols: number,
  maxRows: number,
  notice: PodcastNotice,
): string {
  const title = notice.kind === 'dispatched'
    ? '✅ WRITE CHORD DISPATCHED'
    : '⚠ WRITE CHORD — NOT DISPATCHED';
  const accent = notice.kind === 'dispatched' ? 82 : 196;
  return formatNoticeDialog(maxCols, maxRows, title, notice.body, accent);
}

/**
 * Full-pane "Ship mode blocked" notice (WL-0MUD6DDZC007ZSIW). Renders the
 * guard's plain-text blocked notice inside the same box style as the Code
 * Freeze dialog, so the blocked state reuses the established in-pane modal
 * pattern (esc/enter/q dismiss). Shown INSTEAD of the Ship It dialog when
 * live agent panes are working on project items — the dialog never opens.
 */
export function formatBlockedShipDialog(maxCols: number, maxRows: number, body: string): string {
  return formatNoticeDialog(maxCols, maxRows, '⛔ SHIP MODE BLOCKED', body, 196);
}

/**
 * Build the production Ship Guard query seam (WL-0MUD6DDZC007ZSIW): runs
 * `wl list --json --fields id` and `herdr pane list` and returns their raw
 * stdout, or null for whichever query failed. A null output makes the guard
 * fail safe (the dialog is not opened). The command-output-string shape keeps
 * the guard pure and unit-testable without spawning processes.
 *
 * The worklog query requests ONLY the `id` field (`--fields id`): the guard
 * needs the project's work-item ID set, nothing else. This keeps the payload
 * tiny (~100 KB for ~2.3 k items vs ~8.5 MB for the full worklog) so it no
 * longer risks Node's `maxBuffer` and will not re-break as the worklog grows
 * (WL-0MUEK7H39008VVUF). The `maxBuffer` is raised as a defensive backstop.
 *
 * @param cwd - Project root (contains `.worklog/`); when provided the wl
 *   query targets that root explicitly. When omitted the module-configured
 *   worklog dir is used.
 */
export function createProductionShipGuardQuery(
  cwd?: string,
): () => Promise<{ worklogOutput: string | null; paneOutput: string | null }> {
  // IDs-only worklog query: bounded payload, resilient as the worklog grows.
  const worklogArgs = ['list', '--json', '--fields', 'id'];
  // Generous backstop; the --fields id projection keeps the real payload tiny.
  const SHIP_GUARD_MAX_BUFFER = 32 * 1024 * 1024;
  return async () => {
    const exec = getExecFileAsync();
    let worklogOutput: string | null = null;
    let paneOutput: string | null = null;
    try {
      const wlArgs = cwd ? buildWlArgsForRoot(cwd, worklogArgs) : buildWlArgs(worklogArgs);
      const { stdout } = await exec('wl', wlArgs, {
        encoding: 'utf8',
        timeout: DEFAULT_WL_TIMEOUT_MS,
        maxBuffer: SHIP_GUARD_MAX_BUFFER,
      });
      worklogOutput = stdout;
    } catch {
      worklogOutput = null;
    }
    try {
      const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
      const { stdout } = await exec(herdrBin, ['pane', 'list'], {
        encoding: 'utf8',
        maxBuffer: SHIP_GUARD_MAX_BUFFER,
      });
      paneOutput = stdout;
    } catch {
      paneOutput = null;
    }
    return { worklogOutput, paneOutput };
  };
}

/**
 * Fetch the items for the current view.
 *
 * When a stage filter is active, the worklist shows every root item in that
 * stage matching the stage's status rule (`wl list --status <status> --stage
 * <stage> --root-only`; see STAGE_STATUS in fetcher.ts) — not just the
 * `browseItemCount`-capped `wl next` subset — so stage-filtered views give
 * a complete picture of the stage (WL-0MSDT8X1V003206G). Most stages show
 * `open`-status items only; the in_review stage additionally includes
 * `completed`, `in-progress` and `blocked` items: per the project workflow
 * advancing an item to in_review sets its status to `completed` (or leaves
 * it `in-progress` while being re-worked after review feedback)
 * (WL-0MSKCRX730052IIW), and `blocked` is included (WL-0MV70XY6D008013C) so
 * the review filter matches the release gate's unfiltered `wl list --stage
 * in_review` (a status=blocked in_review item is release-blocking). Child
 * items stay hidden and remain reachable via expand exactly as in the
 * unfiltered view. Results follow the standard list order (sortIndex).
 *
 * Without an active filter the default fetcher is used unchanged (the
 * default `/wl` view keeps its existing smart-selection behaviour). If the
 * stage/priority fetch fails, the default fetcher is used as a fallback so a
 * `wl` error can never blank the list.
 *
 * @param activeFilter - The active stage filter (null = no stage filter)
 * @param activePriorityFilter - The active priority filter (null = no
 *   priority filter). Mutually exclusive with `activeFilter` (replace
 *   semantics, WL-0MSKC8T46006999S): at most one is set.
 * @param defaultFetcher - The default fetcher for the unfiltered view
 * @param activeDispatchFilter - When true, return the log-derived recent
 *   dispatch rows instead of live `wl` items (WL-0MUL2IZLF002S9X5).
 * @param cwd - Project root containing `.worklog/` for the dispatch-log read
 *   (defaults to `process.cwd()`).
 */
export function fetchItemsForView(
  activeFilter: string | null,
  activePriorityFilter: string | null,
  defaultFetcher: () => Promise<WorkItem[]>,
  activeDispatchFilter = false,
  cwd: string = process.cwd(),
): Promise<WorkItem[]> {
  if (activeDispatchFilter) {
    // Recent-dispatches view (WL-0MUL2IZLF002S9X5): the log decides WHICH items
    // appear, but each row is rendered from the LIVE work item (the same
    // `defaultFetcher` every other view uses) so the status/stage/audit/
    // review/priority icons are identical to other views, and the rows are
    // ordered exactly like the main selection list (WL-0MUGLL9SS002E1D2).
    // An item no longer present in `wl` falls back to the log-derived
    // synthetic row so closed/deleted work still appears. Fail-safe — a
    // missing/unreadable log yields []; a live-fetch error degrades to
    // log-only rows rather than blanking the TUI.
    return Promise.all([
      recentDispatchedItems(cwd),
      defaultFetcher().catch(() => [] as WorkItem[]),
    ])
      .then(([rows, liveItems]) => {
        const liveById = new Map(liveItems.map((item) => [item.id, item]));
        // Group the log rows into 4-hour UTC time blocks, oldest block first
        // (WL-0MUMM9NED009TLL3). Each block becomes a numbered group so the
        // existing display-rows model interleaves a heading row before the
        // block's items; within a block the projection's newest-first order
        // is preserved. Group numbers are assigned in block order so no
        // duplicate headings render.
        const projected: WorkItem[] = [];
        groupRecentDispatchesByTimeBlock(rows).forEach((block, index) => {
          for (const row of block.rows) {
            const live = liveById.get(row.itemId);
            const item = live ? mergeDispatchRow(live, row) : buildDispatchWorkItem(row);
            projected.push({ ...item, group: index + 1, groupLabel: block.label });
          }
        });
        return projected;
      })
      .catch(() => []);
  }
  if (activeFilter) {
    // Fail-open: a wl error must never blank the list — fall back to the
    // default fetcher (which itself fails open in index.ts).
    return fetchItemsByStage(activeFilter).catch(() => defaultFetcher());
  }
  if (activePriorityFilter) {
    // Fail-open: same fallback as the stage path.
    return fetchItemsByPriority(activePriorityFilter).catch(() => defaultFetcher());
  }
  // Unfiltered: delegate straight to the default fetcher so the refresh
  // cadence is byte-for-byte unchanged (single-flight timing preserved).
  return defaultFetcher();
}

/**
 * True when a resolved command is a `/wl` view command — a stage filter
 * (`/wl <stage>`, shorthand alias or canonical name), a priority filter
 * (`/wl --priority <p>`, canonical name), the recent-dispatches view
 * (`/wl dispatches`, WL-0MUL2J15W00277XH), or the clear-filter `/wl` with no
 * arguments.
 *
 * Used after dispatch to trigger an immediate view refetch: filtered views
 * show every root item matching the filter's rule (`wl list --status <status>
 * --stage <stage> --root-only` / `--priority <p>`; see STAGE_STATUS in
 * fetcher.ts) — most stages show `open`-status items only, while the in_review
 * stage additionally includes `completed` and `in-progress` items
 * (WL-0MSKCRX730052IIW); the dispatches view refetches the log-derived rows;
 * clearing the filter restores the default view (WL-0MSGSE15000746F7).
 */
export function isWlViewCommand(cmd: string): boolean {
  if (/^\/wl\s*$/.test(cmd)) return true;
  if (/^\/wl\s+dispatches$/.test(cmd)) return true;
  const stageMatch = cmd.match(/^\/wl\s+(\S+)$/);
  if (stageMatch !== null && STAGE_MAP[stageMatch[1]] !== undefined) return true;
  const priorityMatch = cmd.match(/^\/wl\s+--priority\s+(\S+)$/);
  return priorityMatch !== null && PRIORITY_MAP[priorityMatch[1]] !== undefined;
}

/**
 * Best-effort upgrade of a log-derived detail item to the live `wl` item
 * (WL-0MUL2J15W00277XH): when a recent-dispatch row is opened (Enter),
 * `state.detailItem` starts as the synthetic row. This fetches the live item
 * by id and, if it still exists, replaces the detail item so the view shows
 * fresh live metadata; a closed/deleted item (or a fetch error) leaves the
 * log-derived metadata in place — the view never blanks or crashes.
 *
 * @param state - The list state whose `detailItem` is upgraded in place.
 * @param fetchDetails - Injectable single-item fetcher (defaults to the
 *   production `fetchItemDetails`, which already returns null on failure).
 */
export async function resolveDispatchDetail(
  state: WorkItemListState,
  fetchDetails: (id: string) => Promise<WorkItem | null> = fetchItemDetails,
): Promise<void> {
  const item = state.detailItem;
  if (item === null || item === undefined || item.isLogDerived !== true) return;
  const fresh = await fetchDetails(item.id).catch(() => null);
  // Only upgrade when the user has not navigated away in the meantime — the
  // same synthetic object is still the detail item.
  if (fresh !== null && state.detailItem === item) {
    state.detailItem = fresh;
  }
}

/**
 * Dispatch a chord command by mapping it to the appropriate TUI action
 * or routing it through the stdout command output mechanism.
 *
 * Recognised command families:
 * - `/wl <stage>` — stage filter actions (applied internally)
 * - `/skill:implement`, `/skill:audit` — agent skill invocations
 * - `/intake`, `/plan` — agent workflow commands
 * - Compound audit commands containing `&& wl audit-set`
 *
 * @param command - The resolved command string (may contain `<id>` placeholders)
 * @param state - Current work item list state (for selected item lookup)
 * @param onCommand - Optional callback to route non-/wl commands to the output mechanism
 * @param model - Optional model for the routed command
 * @param onDowntimeToggle - Optional callback invoked for the internal
 *   `/downtime toggle` command (flips the per-instance worker override;
 *   never spawns a pane, never writes to stdout — parent
 *   WL-0MSZ4NSOE007AQEF)
 * @param openPane - Optional open-pane flag (WL-0MSJLD1I70045ZUL): `false`
 *   runs the command in the background (no pane); `undefined`/`true` open a
 *   pane as today. Passed to onCommand only when explicitly set.
 * @returns true if the command was handled, false otherwise
 */
export function dispatchChordCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string, focus?: boolean) => void,
  model?: string,
  onDowntimeToggle?: () => void,
  openPane?: boolean,
  onRefresh?: () => Promise<void>,
  focus?: boolean,
): boolean {
  // ── /downtime toggle (internal action, WL-0MSZ4NSOE007AQEF) ──────
  // Per-instance in-memory toggle of downtime dispatch for the current
  // herdr pane. Fully internal — no pane spawned, no stdout write, no
  // <id> substitution. The header re-renders via the worker's state.
  if (/^\/downtime toggle$/.test(command.trim())) {
    if (onDowntimeToggle) {
      onDowntimeToggle();
    }
    return true;
  }

  // ── /wl --priority <priority> commands (internal dispatch) ─────
  // Priority filter axis (WL-0MSKC8T46006999S): `/wl --priority <p>` with a
  // canonical name (critical|high|medium|low) applies the priority filter;
  // unknown values fall through unhandled (no crash, no filter change),
  // matching the `/wl <bogus>` behaviour below.
  const wlPriorityMatch = command.match(/^\/wl\s+--priority\s+(\S+)$/);
  if (wlPriorityMatch) {
    const wlPriority = wlPriorityMatch[1];
    const internalPriority = PRIORITY_MAP[wlPriority];
    if (internalPriority) {
      state.applyPriorityFilter(internalPriority);
      return true;
    }
  }

  // ── /wl dispatches (internal action, WL-0MUL2IZLF002S9X5) ─────
  // Recent-dispatches view: fully internal — no pane spawned, no stdout
  // write, no <id> substitution. Bound to the `f d` chord via shortcuts.json.
  if (/^\/wl\s+dispatches$/.test(command.trim())) {
    state.applyDispatchFilter();
    return true;
  }

  // ── /wl <stage> commands (internal dispatch) ──────────────
  const wlStageMatch = command.match(/^\/wl\s+(\S+)$/);
  if (wlStageMatch) {
    const wlStage = wlStageMatch[1];
    const internalStage = STAGE_MAP[wlStage];
    if (internalStage) {
      state.applyFilter(internalStage);
      return true;
    }
  }

  // ── /wl (no arguments): return to the default unfiltered view ────
  // Equivalent to the Pi TUI's `/wl` with no args (WL-0MSGSE15000746F7):
  // clears the active stage AND priority filters so the next refresh shows
  // the standard smart-selection list. No-op when no filter is active.
  if (/^\/wl\s*$/.test(command)) {
    state.clearFilter();
    return true;
  }

  // ── Agent skill invocations ─────────────────────────────
  if (command.startsWith('/skill:implement')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh, focus);
  }
  if (command.startsWith('/skill:audit')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh, focus);
  }
  if (command.startsWith('/skill:ship')) {
    // Dev→main release (Ship It shortcut, WL-0MSGG5N5Z0074TLY). Global
    // release — no <id> substitution; routed to the agent channel like
    // other /skill:* commands. NOT blocked during a Code Freeze (the ship
    // skill gates itself); only the confirmation dialog precedes dispatch.
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh, focus);
  }

  // ── Agent workflow commands ─────────────────────────────
  if (command.startsWith('/intake')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh, focus);
  }
  if (command.startsWith('/plan')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh, focus);
  }

  // ── Producer review / audit compound commands ───────────
  if (command.startsWith('!!wl reviewed')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh, focus);
  }

  // ── Data-modifying wl commands (close/delete/update/reviewed/search) ──
  // These mutate the work-item data set or change the list contents, so
  // they are routed here (not the generic callback path) so the caller's
  // isWlModifyingCommand check sees 'dispatched' and triggers an immediate
  // list refresh after the command completes (WL-0MTA217DZ003H5K8).
  if (/^!!\s*wl\s+(close|delete|update|reviewed|search)\b/i.test(command)) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh, focus);
  }
  if (command.includes('&& wl audit-set')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh, focus);
  }

  // Unknown command — not handled
  return false;
}

/**
 * Normalize a `.podcast.md` Key File path to the wiki-dir-relative form the
 * TTS skill's `--podcast-file` expects (OSL-0MUTPC7SF0011Y54).
 *
 * The canonical episode `Key Files:` form records the script
 * worklog-root-relative — e.g.
 * `.llm-wiki/wiki/podcast/<stem>/<stem>.podcast.md` — which is the form the
 * `wiki-podcast-script` CLI resolves when it runs with the worklog root as
 * its CWD. The TTS skill instead resolves `--podcast-file` against
 * `--wiki-dir` (default `.llm-wiki/wiki`), so the wiki-root prefix is
 * stripped to leave `podcast/<stem>/<stem>.podcast.md`.
 *
 * - A wiki-dir-relative path (`podcast/...`) or wiki-relative path
 *   (`wiki/...`) is returned unchanged.
 * - A bare `<title>/<title>.podcast.md` is podcast-dir-relative (the legacy
 *   form) and gets the `podcast/` prefix.
 */
function toWikiRelativePodcastPath(script: string): string {
  const normalized = script.replace(/^\.\//, '');
  const wikiRootPrefix = '.llm-wiki/wiki/';
  if (normalized.startsWith(wikiRootPrefix)) {
    return normalized.slice(wikiRootPrefix.length);
  }
  if (normalized.startsWith('podcast/') || normalized.startsWith('wiki/')) {
    return normalized;
  }
  return `podcast/${normalized}`;
}

/**
 * Resolve podcast-progression command markers (`<podcast-target>`,
 * `<podcast-script>`, `<podcast-review>`, `<podcast-both>`) for the selected
 * work item at dispatch time (OSL-0MSKFXM380098LFL, folding in
 * OSL-0MSHFQ51L009IUOS and the OSL-0MSKVB5K6008XFOQ w-chord split).
 *
 * The `w s` write-script sub-chord command
 * (`/skill:wiki-podcast-script <podcast-target>`) derives its mode from the
 * selected item's lifecycle context:
 * - stage `intake_complete` (sourced): author a new script from the source
 *   synthesis → `--doc <first .md Key File> --force-single`;
 * - otherwise, when open editor-note children exist: rewrite the existing
 *   script → `--rewrite <first .podcast.md Key File>`;
 * - otherwise: belt-and-braces guard — returns an error and does NOT
 *   dispatch (never authors a duplicate).
 *
 * The `w r` write-review sub-chord command
 * (`/skill:wiki-podcast-script --review <podcast-review>`) runs the 6
 * reviews on the existing script, and the `w b` write-both sub-chord
 * command (`/skill:wiki-podcast-script --review-rewrite <podcast-both>`)
 * runs reviews + rewrite in one pass (7 LLM calls). Both resolve
 * `<podcast-review>`/`<podcast-both>` to the first `.podcast.md` Key File
 * in raw form (same as the existing `--rewrite` resolution) with a
 * belt-and-braces error when no script exists.
 *
 * The `t` TTS chord command
 * (`/skill:wiki-tts-generate --podcast-file <podcast-script>`) resolves
 * `<podcast-script>` to the first `.podcast.md` Key File, normalized to the
 * wiki-dir-relative `podcast/...` form the TTS skill expects. The canonical
 * episode Key File form is worklog-root-relative
 * (`.llm-wiki/wiki/podcast/<stem>/<stem>.podcast.md`), so the wiki-root
 * prefix is stripped; a bare `<title>/<title>.podcast.md` Key File path is
 * podcast-dir-relative (the legacy form) and gets the `podcast/` prefix
 * (OSL-0MUTPC7SF0011Y54).
 *
 * Markers are resolved BEFORE the generic modal-form check so they never
 * fall through to the input form. Returns the input command unchanged when
 * it carries no podcast markers.
 *
 * @param command - Resolved shortcut command (may contain markers).
 * @param item - Selected work item (or null when nothing is selected).
 * @param fetchChildren - Child fetcher (injectable for tests; defaults to
 *   {@link fetchChildrenForItem}).
 */
export async function resolvePodcastTarget(
  command: string,
  item: WorkItem | null,
  fetchChildren: (parentId: string) => Promise<WorkItem[]> = fetchChildrenForItem,
): Promise<PodcastTargetResolution> {
  const hasTarget = command.includes('<podcast-target>');
  const hasScript = command.includes('<podcast-script>');
  const hasReview = command.includes('<podcast-review>');
  const hasBoth = command.includes('<podcast-both>');
  if (!hasTarget && !hasScript && !hasReview && !hasBoth) {
    return { command };
  }
  if (!item) {
    return { error: 'No work item selected' };
  }

  const mdPaths = extractFilePaths(item.description ?? '').filter(p => p.endsWith('.md'));
  const synthesis = mdPaths.find(p => !p.endsWith('.podcast.md')) ?? mdPaths[0];
  const script = mdPaths.find(p => p.endsWith('.podcast.md'));
  let resolved = command;

  if (hasTarget) {
    // `w` write-script chord: mode derives from stage + open notes.
    if (item.stage === 'intake_complete') {
      // Sourced episode — author a new script from the synthesis.
      if (!synthesis) {
        return { error: 'No source synthesis found in Key Files: — run wiki-ingest-batch/research first' };
      }
      resolved = resolved.replace(/<podcast-target>/g, `--doc ${synthesis} --force-single`);
    } else {
      // Drafted/written episode — rewrite only when a script exists AND open
      // note children exist. The missing-script check MUST run first: without
      // it, a script-less episode at a script-bearing stage reported the
      // false "podcast script already present" message (OSL-0MUQ59IRF009ICIF).
      if (!script) {
        return { error: 'No podcast script found in Key Files: — this episode has not been drafted; add the script path to Key Files, or move the item back to intake_complete to author from the synthesis' };
      }
      let children: WorkItem[] = [];
      try {
        children = await fetchChildren(item.id);
      } catch {
        children = [];
      }
      const openNotes = children.filter(c => {
        const status = c.status ?? '';
        return status !== 'completed' && status !== 'closed' && status !== 'deleted';
      });
      if (openNotes.length === 0) {
        return { error: 'podcast script already present, review and edit that rather than author a new one' };
      }
      resolved = resolved.replace(/<podcast-target>/g, `--rewrite ${script}`);
    }
  }

  if (hasScript) {
    if (!script) {
      return { error: 'No podcast script found in Key Files: — author the script first (w)' };
    }
    // Episode Key Files record the script worklog-root-relative; normalize
    // to the wiki-dir-relative form the TTS skill's --podcast-file expects.
    const podcastFile = toWikiRelativePodcastPath(script);
    resolved = resolved.replace(/<podcast-script>/g, podcastFile);
  }

  // `w r` write-review / `w b` write-both sub-chords: both require an
  // existing script and resolve the marker to the raw first `.podcast.md`
  // Key File (same raw form the `--rewrite` resolution uses). The chords
  // are stage-gated to script-bearing stages, but a belt-and-braces guard
  // still protects the unfiltered/edge case (OSL-0MSKVB5K6008XFOQ).
  if (hasReview || hasBoth) {
    if (!script) {
      return { error: 'No podcast script found in Key Files: — author the script first (w)' };
    }
    if (hasReview) {
      resolved = resolved.replace(/<podcast-review>/g, script);
    }
    if (hasBoth) {
      resolved = resolved.replace(/<podcast-both>/g, script);
    }
  }

  return { command: resolved };
}

/**
 * Execute a resolved chord command.
 *
 * Routing priority:
 * 1. {@link dispatchChordCommand} — handles `/wl <stage>` (internal filter),
 *    `/skill:implement`, `/skill:audit`, `/skill:ship`, `/intake`, `/plan`,
 *    and compound `&& wl audit-set` commands (resolves
 *    `<id>` and routes to `onCommand`). Returns 'dispatched'.
 * 2. Code Freeze guard — when `codeFreezeActive` is true and the command is
 *    an implement command, the command is NOT routed; returns 'blocked' so
 *    the caller can show the Code Freeze dialog instead of spawning a pane.
 * 3. For unrecognised command families, resolves `<id>` placeholders and
 *    passes to the optional `onCommand` callback. Returns 'callback'.
 * 4. If the command contains `<id>` but no item is selected, silently
 *    drops with 'noop'.
 *
 * @param command - The resolved command string (may contain `<id>` placeholders)
 * @param state - Current work item list state (for selected item lookup)
 * @param onCommand - Optional callback to receive resolved commands
 * @param codeFreezeActive - Whether the project is in Code Freeze (implement
 *                           commands are blocked). Defaults to false.
 * @param model - Optional model for the routed command.
 * @param onDowntimeToggle - Optional callback for the internal
 *   `/downtime toggle` command (see {@link dispatchChordCommand}).
 * @param openPane - Optional open-pane flag (WL-0MSJLD1I70045ZUL): `false`
 *   runs the command in the background (no pane); `undefined`/`true` open a
 *   pane as today. Passed to onCommand only when explicitly set.
 * @returns 'dispatched' if handled by dispatchChordCommand,
 *          'callback' if passed to onCommand,
 *          'noop' if skipped (no item + <id> requirement),
 *          'blocked' if frozen and the command is an implement command.
 */
export function executeResolvedCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string, focus?: boolean) => void,
  codeFreezeActive = false,
  model?: string,
  onDowntimeToggle?: () => void,
  openPane?: boolean,
  onRefresh?: () => Promise<void>,
  focus?: boolean,
): ExecuteResult {
  // Code Freeze guard: never route implement commands while frozen.
  // This runs BEFORE dispatchChordCommand so no pane spawn, claim, or
  // <id> substitution can happen for a blocked command.
  if (codeFreezeActive && isImplementCommand(command)) {
    return 'blocked';
  }

  // Try dispatchChordCommand first — handles /wl, /downtime, /skill:,
  // /intake, /plan, and compound audit commands. Focus
  // (WL-0MT70LC6B009TL3Q) is threaded through so the new pane can be focused
  // when requested (only `P n` today).
  if (dispatchChordCommand(command, state, onCommand, model, onDowntimeToggle, openPane, onRefresh, focus)) {
    return 'dispatched';
  }

  // Not a recognised command family — resolve <id> placeholders and call onCommand
  let resolvedCommand = command;
  let itemId: string | undefined;

  if (resolvedCommand.includes('<id>')) {
    const selected = state.getSelectedItem();
    if (selected) {
      resolvedCommand = resolvedCommand.replace(/<id>/g, selected.id);
      itemId = selected.id;
    } else {
      // No item selected and command requires <id> — graceful no-op
      return 'noop';
    }
  } else {
    itemId = extractWorkItemIdFromCommand(resolvedCommand);
  }

  // Record before execution so failures never skip the log entry.
  logCommandForItem(resolvedCommand, itemId);

  if (onCommand) {
    // Descriptive pane title (WL-0MSJ4E8UA005KG9Y): thread the selected
    // item's title forward so the caller can build a pane name without an
    // extra wl spawn. Only pane-opening routes (agent + shell commands)
    // need it; plain commands derive nothing from the title and keep the
    // 2-arg call (byte-compatible).
    const selected = state.getSelectedItem();
    const paneTitle =
      selected && (isAgentCommand(resolvedCommand) || resolvedCommand.startsWith('!'))
        ? selected.title
        : undefined;
    // The openPane flag is passed only when explicitly set (false): an
    // undefined third arg keeps the 2-arg call identical to today's
    // dispatch, so shortcuts without open_pane are byte-compatible
    // (WL-0MSJLD1I70045ZUL). `focus`/`onRefresh`/`paneTitle` follow the rules
    // documented on invokeOnCommand. Centralised so the placeholder form
    // dialog (WL-0MV6J4HQ0009OJPQ) and the placeholder-free paths can never
    // drift apart.
    invokeOnCommand(onCommand, resolvedCommand, model, openPane, onRefresh, paneTitle, focus);
  }
  return 'callback';
}

/**
 * Run the main selection list TUI. This function:
 * 1. Sets up raw terminal mode
 * 2. Enters an event loop reading keypresses
 * 3. Calls the fetcher to load/refresh items
 * 4. Renders the current state
 * 5. Exits when the user presses 'q'
 *
 * @param fetcher - Async function that returns the work items to display
 * @param initialItems - Pre-loaded items (optional, for testing)
 * @param shortcutRegistry - Optional shortcut registry for chord handling
 * @returns The selected WorkItem when the user presses enter, or undefined
 */
export async function runWorklistTui(
  fetcher: () => Promise<WorkItem[]>,
  initialItems?: WorkItem[],
  shortcutRegistry?: { lookupChord: Function; getChordByLeader: Function; getChordByPrefix: Function; getChordEntries: Function } | ShortcutRegistry | undefined,
  options?: { autoRefresh?: boolean; refreshIntervalMs?: number; autoSync?: boolean; syncIntervalMs?: number; browseItemCount?: number; showHelpText?: boolean; getShowHelpText?: () => boolean; showIcons?: boolean; getShowIcons?: () => boolean; onCommand?: (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string) => void; downtimeWorker?: DowntimeWorker; downtimePollIntervalMs?: number; applyActivePaneMarkers?: (items: WorkItem[]) => Promise<void>; subscriber?: HerdrEventSubscriber | null; agentTracker?: AgentTracker | null; onDowntimeToggle?: () => void; maxSyncStalenessMs?: number; onRefresh?: () => Promise<void>; cwd?: string; shipGuardQuery?: () => Promise<{ worklogOutput: string | null; paneOutput: string | null }>; dbWatch?: typeof watchDbChanges; dbWatchOptions?: WatchDbChangesOptions },
): Promise<WorkItem | undefined> {
  const opts = {
    autoRefresh: options?.autoRefresh ?? true,
    refreshIntervalMs: options?.refreshIntervalMs ?? 30000,
    autoSync: options?.autoSync ?? true,
    syncIntervalMs: options?.syncIntervalMs ?? 60000,
    browseItemCount: options?.browseItemCount ?? 10,
    showHelpText: options?.showHelpText ?? true,
    getShowHelpText: options?.getShowHelpText ?? (() => options?.showHelpText ?? true),
    showIcons: options?.showIcons ?? true,
    getShowIcons: options?.getShowIcons ?? (() => options?.showIcons ?? true),
    onCommand: options?.onCommand,
    downtimeWorker: options?.downtimeWorker,
    downtimePollIntervalMs: options?.downtimePollIntervalMs ?? DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
    applyActivePaneMarkers: options?.applyActivePaneMarkers,
    subscriber: options?.subscriber ?? null,
    agentTracker: options?.agentTracker ?? null,
    onDowntimeToggle: options?.onDowntimeToggle,
    maxSyncStalenessMs: options?.maxSyncStalenessMs ?? 60_000,
    onRefresh: options?.onRefresh,
    cwd: options?.cwd,
    shipGuardQuery: options?.shipGuardQuery ?? createProductionShipGuardQuery(options?.cwd),
    dbWatch: options?.dbWatch ?? watchDbChanges,
    dbWatchOptions: options?.dbWatchOptions,
  };

  let termSize = getTermSize();

  /**
   * Apply the pane-based active marker to freshly fetched items: any item
   * with a matching pane title in THIS workspace is shown as `in-progress`
   * (marker + Group N), independent of the worklog status the demotion loop
   * maintains. This makes the selection list's marker reflect pane existence
   * directly (WL-0MV1BWETT005GSUJ). The production implementation is
   * injected by `index.ts`; when absent it is a no-op, so tests never spawn
   * `herdr`. Fail-open — a pane lookup failure leaves every item unchanged.
   */
  const applyPaneMarkers = async (list: WorkItem[]): Promise<void> => {
    try {
      await opts.applyActivePaneMarkers?.(list);
    } catch {
      // Fail-open: a marker failure must never break the refresh/render.
    }
  };

  // Load items
  let items: WorkItem[];
  try {
    items = initialItems ?? await fetcher();
  } catch {
    items = [];
  }
  // Reflect open item panes on the very first render (no 30 s wait). Kicked
  // off without blocking TUI startup; the marker lands on a follow-up render
  // once the pane lookup resolves (fail-open).
  void applyPaneMarkers(items).then(() => render());

  // Fetch total actionable count (best effort — failure is silent)
  fetchActionableCount().then((count) => {
    totalActionableCount = count;
    render();
  }).catch(() => {
    // ignore
  });

  const state = new WorkItemListState(items, termSize);

  /**
   * Re-evaluate pane existence against the CURRENT items (no `wl` re-fetch)
   * and re-render. Called on the hydrate cadence and on focus-resume so an
   * opened/closed work-item pane changes the marker within one cadence even
   * though it does not touch the worklog DB (which is why the DB-gated
   * refresh tick cannot be relied on for this). Spawns only `herdr pane list`,
   * never `wl`. Fail-open (see `applyPaneMarkers`).
   */
  const refreshPaneMarkers = async (): Promise<void> => {
    await applyPaneMarkers(state.allItems());
    render();
  };

  // Icons are gated by the getShowIcons getter (re-read on every render so a
  // showIcons setting change applies without a plugin restart — same pattern
  // as getShowHelpText). The renderer is created per-TUI-run with the getter.
  const renderer = createListRenderer(opts.getShowIcons);

  // ── Metadata-panel dependency blockers (WL-0MV8EZRDJ001TDA8) ────────
  // Resolved for the SELECTED item only (never every list row) and cached by
  // item ID. The cache SURVIVES list refreshes (WL-0MV8Q5X8U004KKAP): the
  // previous implementation cleared it on EVERY refresh, which re-entered the
  // unresolved frame and made the `Blocked By` line flicker on/off endlessly
  // under the frequent refresh traffic of a live workspace (DB-change watch
  // + auto-sync + `wl next` re-sorts all bump the read-cache counter).
  //
  // Invalidation: a cached entry is reused while the item's payload signature
  // (status/stage/updatedAt) is unchanged. A signature change — a dependency
  // add/remove reconciles the from-item's status (`blocked` ↔ `open`) and
  // bumps `updatedAt` — invalidates just that entry. While a re-resolve is in
  // flight the last known value is still served (stale-while-revalidate), so
  // a refresh never blanks the line and a stable selection shows exactly one
  // unresolved→resolved transition. The render path never blocks: an item
  // with no cached value renders without `Blocked By` rows and a follow-up
  // render shows them once the async lookup lands.
  //
  // Single-flight: the in-flight lookup is memoised per item, so repeated
  // renders/refreshes while it is pending share one spawn (no race/duplicate)
  // and the resolved value is re-rendered from cache thereafter.
  //
  // Fail-open — a lookup error caches an empty list so a broken `wl dep list`
  // can never break rendering or navigation (mirrors resolveMetaLastCommand).
  const blockerCache = new Map<string, { blockers: BlockerRef[]; signature: string }>();
  const blockerInFlight = new Map<string, Promise<BlockerRef[]>>();

  /**
   * Payload signature of an item whose change can invalidate its cached
   * blockers. A dependency edge add/remove reconciles the from-item's status
   * and bumps `updatedAt` (packages/shared/src/database.ts
   * `reconcileDependentStatus`), so a signature change is the refresh-time
   * signal that the item's edges may have changed. Fields absent from a
   * payload collapse to empty strings, keeping the comparison stable.
   *
   * Known residual: an edge change that leaves the from-item's payload
   * untouched (e.g. adding a second blocker to an already-`blocked` item, or
   * a blocker target completing while other blockers keep the item `blocked`)
   * does not change the signature and the cache serves the last resolved rows
   * until the item itself changes or it is re-selected. This is the accepted
   * trade-off of the AC-2 invalidation rule (reuse until the item changes)
   * — the alternative (re-resolve on every refresh) is the flicker this item
   * fixes.
   */
  const blockerSignature = (item: WorkItem): string =>
    `${item.id}|${item.status ?? ''}|${item.stage ?? ''}|${item.updatedAt ?? ''}`;

  const resolveMetaBlockers = (item: WorkItem | null): BlockerRef[] | undefined => {
    if (!item) return undefined;
    // Synthetic log-derived rows have no live `wl` counterpart; blockers are
    // only meaningful for live rows, so skip the lookup (WL-0MUL2IY8L009S3PQ).
    if (item.isLogDerived || item.isLogOnly) return undefined;
    const signature = blockerSignature(item);
    const cached = blockerCache.get(item.id);
    // Cached value whose signature still matches the payload — reuse it,
    // never re-entering the unresolved frame or re-spawning the lookup.
    if (cached !== undefined && cached.signature === signature) return cached.blockers;
    if (!blockerInFlight.has(item.id)) {
      // Fail-open even against an unexpectedly unavailable helper (tests may
      // replace the fetcher module): never let the lookup break a render.
      let lookup: Promise<BlockerRef[]>;
      try {
        lookup = fetchBlockersForItem(item.id);
      } catch {
        // Synchronous throw: cache the fail-open empty list and stop.
        blockerCache.set(item.id, { blockers: [], signature });
        return [];
      }
      const inFlight = lookup
        .then((blockers) => {
          blockerCache.set(item.id, { blockers, signature });
          return blockers;
        })
        .catch(() => {
          // Fail-open: never surface a blocker lookup failure.
          blockerCache.set(item.id, { blockers: [], signature });
          return [] as BlockerRef[];
        })
        .finally(() => {
          blockerInFlight.delete(item.id);
          render();
        });
      blockerInFlight.set(item.id, inFlight);
    }
    // A re-resolve is in flight: serve the last known value so a refresh
    // never drops the line (stale-while-revalidate). On a first resolve
    // there is none yet, so render no rows this frame and let the follow-up
    // render show them — the one unresolved→resolved transition per selection.
    return cached?.blockers;
  };
  const chordState: ChordState = createChordState();
  let formState: FormState | null = null;
  /** Saved mode before entering form overlay (to restore on cancel) */
  let preFormMode: ViewMode = 'list';
  /**
   * The mode the help overlay returns to when dismissed (WL-0MV85R14Y003RII9).
   * Mirrors the `preFormMode` pattern: opening help records the mode, and
   * `?`/Esc/`q` restore it without mutating list state.
   */
  let preHelpMode: ViewMode = 'list';
  /**
   * Vertical scroll offset of the help overlay's content window (2026-10-16
   * producer audit: the overlay must be scrollable). Reset to 0 every time
   * the overlay opens; clamped to the last window in `formatHelpScreen`.
   */
  let helpScrollOffset = 0;
  /**
   * Ship It confirmation dialog (WL-0MSGG5N5Z0074TLY). Non-null while the
   * dialog is open; its buffer holds the typed confirmation input. The
   * dialog is bottom-anchored — the selection list stays visible above it.
   */
  let shipItDialog: ShipItDialogState | null = null;

  let totalActionableCount: number | undefined;

  // Code Freeze state: whether the project is frozen (banner) and whether
  // the Code Freeze notice dialog is currently showing. The banner state is
  // refreshed on each data refresh; the command-dispatch path re-reads the
  // marker fresh so a freeze that starts between refreshes is still enforced
  // at dispatch time (fail-safe client-side blocking). `codeFreezeAmbiguous`
  // drives the separate "Ambiguous Codefreeze marker" banner
  // (WL-0MSQ0RPQP00636JY): a marker that cannot be parsed disables
  // implement/audit downtime dispatch (fail-closed) and the operator must
  // see why. Browsing/shortcut blocking keep their fail-open semantics —
  // `codeFreezeActive` stays false for an ambiguous marker.
  let codeFreezeActive = false;
  let codeFreezeAmbiguous = false;
  let codeFreezeNotice = false;
  /**
   * Ship-mode blocked notice (WL-0MUD6DDZC007ZSIW). Non-null while the guard
   * has refused to open the Ship It dialog: holds the formatted plain-text
   * notice listing the blocking panes/work items. Modal — Esc/Enter/q dismiss
   * it; no command is ever dispatched while it is showing.
   */
  let blockedNotice: string | null = null;

  // Persistent, dismissable notice for a podcast w-chord dispatch attempt
  // (OSL-0MUQ59IRF009ICIF). Replaces the transient toast for the w-r/w-s/w-b
  // (and t) markers so a refused dispatch — e.g. the belt-and-braces
  // "already present" guard — can never look like a silently dropped key.
  let podcastNotice: PodcastNotice | null = null;

  /**
   * Single source of truth for "the user is typing" (WL-0MTV67MZU003H7SH):
   * true while any text-input overlay (`formState`, `shipItDialog`, or the
   * modal `blockedNotice`) is open. Background refresh/sync paths consult this
   * so no re-render or `wl` spawn contends with typing — whichever path
   * triggers the work (scheduler tick, focus-resume, event subscriber, or the
   * command-completion hook). See {@link isInputActive}.
   */
  const inputActive = (): boolean =>
    isInputActive(formState, shipItDialog, blockedNotice !== null || podcastNotice !== null);

  /**
   * Re-read the code-freeze marker tri-state. Fail-open for browsing: an
   * ambiguous marker keeps `codeFreezeActive` false (browsing and shortcut
   * blocking are unchanged); only the ambiguous-marker banner state and the
   * downtime dispatcher's fail-closed gate are affected
   * (WL-0MSQ0RPQP00636JY).
   */
  const refreshFreezeState = (): void => {
    const status = readCodeFreezeStatus();
    codeFreezeActive = status === 'frozen';
    codeFreezeAmbiguous = status === 'ambiguous';
  };

  // Initial Code Freeze state read (fail-open: no marker => not frozen).
  refreshFreezeState();

  // ── Review-queue depth indicator (display-only — parent
  // WL-0MTHSHN5V008R5L0's "sprint complete" banner reconciled by
  // WL-0MTTSWC1X005P4VD) ───────────────────────────────────────
  // A completed + in_review ROOT-ITEM count >= browseItemCount is a
  // REVIEW-QUEUE DEPTH signal, NOT a sprint completion: queue depth must
  // never auto-disable the downtime worker (RCA root cause A — the
  // auto-disable halted coordination check-ins/audits/plan/intake and
  // caused the 21:53Z silence). The banner is display-only; the
  // `.herdr-downtime-disabled` marker is written ONLY by the manual `d`
  // toggle in the downtime worker.
  let sprintComplete = false;
  let sprintCompletedCount = 0;
  let sprintAuditsOutstanding = false;

  // ── Assignee scheduling-hold surface (WL-0MVR8FN1D002SCIR) ───────
  // Derived from the ALREADY-FETCHED dispatch window on every refresh (no
  // new `wl` spawn) and purely display-only: it never clears a hold and
  // never changes a dispatch decision (AC4). `null` while a filter narrows
  // the list — a filtered window cannot answer "is the WHOLE window held?"
  // (fail-safe: no warning rather than a false one).
  let assigneeHoldSummary: DispatchWindowHoldSummary | null = null;

  /**
   * Recompute the assignee-hold account from the window the worklist just
   * rendered. Skipped for any filtered/dispatch-derived view, whose items are
   * not the canonical dispatch window.
   */
  const applyAssigneeHoldState = (items: WorkItem[]): void => {
    const filtered =
      state.activeFilter !== null ||
      state.activePriorityFilter !== null ||
      state.activeDispatchFilter;
    assigneeHoldSummary = filtered
      ? null
      : summariseDispatchWindowHold(items, {
          windowSize: resolveSprintViewWindow(loadSettings().browseItemCount ?? opts.browseItemCount),
        });
  };

  /**
   * Apply a pre-fetched review-queue-depth state to the banner indicator
   * (display-only; completed+in_review root count vs browseItemCount, plus
   * whether any of those items still has an outstanding audit — this drives
   * the banner copy; AH-0MUDYTQ55002NUSJ). Fail-closed: `undefined` (a query
   * failure) leaves the state unchanged. Queue depth never writes the disable
   * marker (WL-0MTTSWC1X005P4VD).
   *
   * Split from the fetch so `doRefresh` can run the fetch CONCURRENTLY with
   * the item fetch and deduplicate it against the identical review query in
   * `fetchMandatorySubsets` (WL-0MV5CBQ6L005SPAG).
   */
  const applySprintState = (state: ReviewQueueState | undefined): void => {
    if (state === undefined) return; // fail-closed: unknown state → no change
    sprintCompletedCount = state.count;
    sprintAuditsOutstanding = state.auditsOutstanding;
    // Re-read browseItemCount live so a settings change applies without a plugin restart.
    const liveBrowseCount = loadSettings().browseItemCount ?? opts.browseItemCount;
    sprintComplete = state.count >= liveBrowseCount;
  };

  // Pane-visibility gating (pause-when-hidden). When the pane's tab is not
  // focused, auto-refresh/auto-sync timer ticks are skipped so hidden panes
  // stop spawning wl processes. Fail-open: when visibility can't be
  // determined (no HERDR_TAB_ID / CLI error) the pane is treated as visible
  // and polling proceeds as today. Tab focus is the signal (herdr tab get
  // -> result.tab.focused); PollGate memoizes the tab-get exec within a
  // TTL so refresh+sync ticks in one cycle share a single `herdr tab get`.
  const paneGate = new PollGate(isPaneVisible, DEFAULT_POLL_GATE_TTL_MS);
  // Whether the pane is currently hidden (drives the header indicator).
  // Updated by the gate check on each timer tick; fail-open defaults to false.
  let panePaused = false;

  // ── Event-driven window status (WL-0MSHB7DHO004RHBJ) ──────────────
  // The herdr event subscriber (when available) replaces the polling paths:
  //  - `pane_focused` for the CURRENT pane → immediate visibility update
  //    + refresh (replaces the 2s resume-poll for hidden→visible).
  //  - `pane_agent_status_changed` / `pane_agent_detected` / `pane_closed` /
  //    `pane_exited` → immediate icon updates (replaces the agent-list poll).
  // Polling stays the fail-open fallback whenever events are unavailable.
  const subscriber = opts.subscriber;
  const agentTracker = opts.agentTracker;

  /** True while the event subscription is healthy (drives resume-poll gating). */
  let eventsActive = false;

  /**
   * Sync the subscriber's per-pane subscriptions with the tracker's pane
   * set (from the shared `.worklog/agent-panes.json`). Per-pane
   * `pane.agent_status_changed` subscriptions must exist for every tracked
   * pane so status events are received (AC1/AC3). Late-spawned agents are
   * covered by `pane_agent_detected` + re-reading the shared file.
   * Best-effort: subscription failures never break the event loop.
   */
  const syncPaneSubscriptions = async (): Promise<void> => {
    if (!subscriber || !agentTracker) return;
    try {
      const current = new Set(subscriber.getTrackedPaneIds());
      const missing: string[] = [];
      for (const entry of agentTracker.snapshot()) {
        if (!current.has(entry.paneId)) missing.push(entry.paneId);
      }
      if (missing.length > 0) {
        // Batch: herdr accepts ONE events.subscribe per connection, so all
        // new panes are applied by re-establishing the connection ONCE with
        // the combined set (WL-0MVAS988R008PNH6) — never one restart per pane.
        await subscriber.addPaneSubscriptions(missing);
      }
    } catch {
      // Fail-open: a subscription sync failure keeps polling as fallback.
    }
  };

  /**
   * Re-evaluate pane existence and re-render after a pane lifecycle event
   * (agent status change, agent detected, pane closed/exited). The row's
   * green-circle icon is pane-title existence (WL-0MV1BWETT005GSUJ), so an
   * event that opens or closes a work-item pane must refresh the pane list.
   * Single-flight across concurrent events; visibility-gated so a hidden tab
   * spawns no `herdr`; fail-open (see `applyPaneMarkers`).
   *
   * The single-flight guard COALESCES (it never drops): an event that lands
   * while a pass is in flight marks the refresh pending and the pass re-runs
   * once it settles. A pane can therefore appear during an in-flight pass
   * (`pane_agent_detected` → status change) and still get its green circle
   * (WL-0MVFX70SB000YRQH — dropping the trailing event left the cross-instance
   * late-pane case without a circle).
   */
  let paneMarkerRefreshInFlight: Promise<void> | null = null;
  let paneMarkerRefreshPending = false;
  const refreshPaneMarkersFromEvent = (): void => {
    if (paneMarkerRefreshInFlight) {
      paneMarkerRefreshPending = true;
      return;
    }
    paneMarkerRefreshInFlight = (async () => {
      try {
        do {
          paneMarkerRefreshPending = false;
          // Typing gate (WL-0MTV67MZU003H7SH): do not re-render the TUI (and
          // its open overlay) while a text-input overlay is active.
          if (inputActive()) return;
          if (await paneGate.visible()) {
            await refreshPaneMarkers();
          }
        } while (paneMarkerRefreshPending);
      } catch {
        // Fail-open: pane-marker failures never crash the TUI.
      } finally {
        paneMarkerRefreshInFlight = null;
      }
    })();
  };

  if (subscriber) {
    subscriber.setCallbacks({
      // A pane_focused event for the CURRENT pane means its tab is focused
      // (a pane cannot hold focus while its tab is hidden) → visible.
      // Applies the event value to the gate (no `herdr tab get` exec),
      // clears the paused indicator, and refreshes immediately — replacing
      // the 2s resume-poll for the hidden → visible transition.
      onPaneFocused: (data) => {
        const currentPaneId = process.env.HERDR_PANE_ID;
        if (!currentPaneId || data.pane_id !== currentPaneId) return;
        if (data.focused === false) {
          paneGate.setVisibleFromEvent(false);
          panePaused = true;
          return;
        }
        paneGate.setVisibleFromEvent(true);
        panePaused = false;
        stopResumePoll();
        doRefresh(true);
        // Hydrator focus-resume (AC4): the tab became visible, so re-check
        // `in_progress` claims immediately — the same runner the 30 s hydrate
        // task uses (WL-0MSHB7DHO004RHBJ + WL-0MV1BWETT005GSUJ).
        void runHydrator();
      },
      // Agent-status events keep the tracker's association bookkeeping
      // fresh (the shared `.worklog/agent-panes.json` feeds the hover
      // tooltip and pane subscriptions); the ROW icon is pane-title
      // existence, refreshed from the pane list so a pane that just
      // appeared/disappeared updates the green circle without a 30 s wait.
      // (WL-0MV1BWETT005GSUJ — no longer any `herdr agent list` icon merge.)
      onAgentStatusChanged: (data) => {
        if (!agentTracker) return;
        agentTracker.applyAgentStatusChanged(data.pane_id, data.agent_status);
        refreshPaneMarkersFromEvent();
      },
      // A new agent pane appeared (possibly from another herdr instance):
      // re-read the shared file for late associations and add the pane to
      // the per-pane subscription set (AC3), then refresh the pane-existence
      // icons.
      onAgentDetected: (data) => {
        if (!agentTracker || !subscriber) return;
        const grew = agentTracker.applyAgentDetected();
        if (grew) void syncPaneSubscriptions();
        void subscriber.addPaneSubscription(data.pane_id).catch(() => {});
        refreshPaneMarkersFromEvent();
      },
      // A pane closed/exited: prune its associations so its hover metadata
      // disappears immediately and drop the per-pane subscription
      // (best-effort); the pane-existence marker (green circle) is re-read
      // from the pane list.
      onPaneClosed: (data) => {
        if (!agentTracker || !subscriber) return;
        agentTracker.applyPaneGone(data.pane_id);
        void subscriber.removePaneSubscription(data.pane_id).catch(() => {});
        refreshPaneMarkersFromEvent();
      },
      onPaneExited: (data) => {
        if (!agentTracker || !subscriber) return;
        agentTracker.applyPaneGone(data.pane_id);
        void subscriber.removePaneSubscription(data.pane_id).catch(() => {});
        refreshPaneMarkersFromEvent();
      },
      onError: () => {
        // The event stream dropped (socket error/close). The subscriber
        // reconnects with backoff; meanwhile flip back to the resume-poll
        // fallback so a hidden → visible transition still refreshes
        // immediately while events are down (WL-0MVAS988R008PNH6 AC3/AC1).
        // `onReconnected` below restores the event path on recovery.
        if (eventsActive) {
          eventsActive = false;
          void paneGate.visible().then((visible) => {
            if (!visible) startResumePoll();
          });
        }
      },
      onReconnected: () => {
        // Stream re-established (restart or backoff reconnect): the event
        // path drives focus/refresh again — stop the resume-poll fallback
        // and top up per-pane subscriptions for any pane tracked meanwhile.
        eventsActive = true;
        stopResumePoll();
        void syncPaneSubscriptions();
      },
    });

    // Start the subscription (fail-open: an unreachable socket keeps the
    // existing polling cadence and the resume-poll fallback).
    subscriber.connect().then((result) => {
      eventsActive = result.type === 'subscribed';
      if (eventsActive) {
        // The event path now handles hidden → visible transitions; stop the
        // resume-poll fallback (it may have started during the connect
        // window while eventsActive was still false).
        stopResumePoll();
        void syncPaneSubscriptions();
      }
    });
  }

  // Check if we're in raw mode (stdin is a TTY)
  const isInteractive = process.stdin.isTTY;
  let rawMode = false;

  // SGR mouse tracking is enabled by default (WL-0MT0AP2LR000JFWN). This is
  // a toggle state so the user can temporarily disable mouse tracking and use
  // the terminal's native text-selection to copy content from the terminal.
  let mouseTrackingEnabled = true;

  // Alt+m toggle handler (WL-0MT0AP2LR000JFWN): toggles mouse tracking on/off
  // by emitting the matching enable/disable ANSI sequences to the terminal.
  const toggleMouseTracking = (): void => {
    mouseTrackingEnabled = !mouseTrackingEnabled;
    process.stdout.write(
      mouseTrackingEnabled ? ANSI.mouseEnable : ANSI.mouseDisable,
    );
  };

  if (isInteractive) {
    try {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      rawMode = true;
      // SGR mouse tracking (WL-0MSGHM5BQ0096BNJ AC1): emit the enable
      // sequences when raw mode is entered so the terminal starts
      // delivering mouse events to stdin.
      process.stdout.write(ANSI.mouseEnable);
    } catch {
      // Not a TTY, use line-buffered mode
    }
  }

  // ── Non-blocking sync status notice (F3 — WL-0MVJV2O7H003HY9N) ────
  // The pane renders a tiny `⟳ syncing… Ns` notice in the header while a
  // background `wl sync` is in flight (auto-sync.ts's status model). The
  // notice is a pure string read of that snapshot: it never awaits, locks or
  // touches the DB, so input handling and refreshes stay fully responsive
  // while a long (~36 s) sync runs. `syncNoticeText` is recomputed on every
  // status transition and, while in flight, on a 1 s unref'd ticker so the
  // elapsed counter keeps moving (the operator sees progress, not a hang).
  let syncNoticeText = '';
  let syncNoticeTicker: ReturnType<typeof setInterval> | null = null;
  let unsubscribeSyncStatus: (() => void) | null = null;

  const stopSyncNoticeTicker = (): void => {
    if (syncNoticeTicker !== null) {
      clearInterval(syncNoticeTicker);
      syncNoticeTicker = null;
    }
  };

  const refreshSyncNotice = (): void => {
    syncNoticeText = formatSyncNotice();
  };

  const startSyncNoticeTicker = (): void => {
    if (syncNoticeTicker !== null) return;
    syncNoticeTicker = setInterval(() => {
      refreshSyncNotice();
      render();
    }, 1000);
    // Never keep the pane process alive just for the status notice.
    if (syncNoticeTicker.unref) syncNoticeTicker.unref();
  };

  // Setup cleanup
  const cleanup = (): void => {
    // Clear form mode on cleanup
    formState = null;
    state.mode = preFormMode;
    if (rawMode) {
      try {
        process.stdin.setRawMode?.(false);
      } catch {
        // ignore
      }
      // Disable SGR mouse tracking on exit (AC1) — only when raw mode was
      // entered.
      process.stdout.write(ANSI.mouseDisable);
    }
    process.stdin.pause();
    process.stdout.write(ANSI.showCursor);
    process.stdout.write(ANSI.reset);
    // Sync-notice teardown: stop the in-flight elapsed ticker and drop the
    // status subscription so an exiting pane cannot leak a timer or receive
    // status callbacks after teardown (F3 — WL-0MVJV2O7H003HY9N).
    stopSyncNoticeTicker();
    if (unsubscribeSyncStatus) unsubscribeSyncStatus();
  };

  // Event-subscriber teardown on TUI exit (WL-0MSHB7DHO004RHBJ F6): close
  // the socket and cancel reconnect timers so no connection leaks when the
  // plugin pane exits. Fail-open: a close failure is swallowed.
  const closeEventSubscriber = (): void => {
    if (subscriber) {
      subscriber.close().catch(() => {});
    }
  };

  // Data reading callback

  /**
   * In-flight guard: true while a refresh cycle is awaiting its fetcher/wl
   * calls. A refresh tick that fires while this is set is SKIPPED
   * (single-flight), so refresh cycles never overlap and wl processes cannot
   * pile up under load (WL-0MSBVYBMD004007C). Cleared in `finally` so a
   * rejecting fetcher can never leave the guard stuck. Per-pane scope
   * (declared inside runWorklistTui): panes refresh independently. A skipped
   * tick is not coalesced — the next tick or a manual refresh updates the
   * list (no stale-forever regression). Mirrors the `_syncInFlight` guard in
   * auto-sync.ts.
   */
  let refreshInFlight = false;

  /**
   * Coalescing flag: set when a refresh is requested while one is already
   * in-flight. The trailing refresh runs after the current cycle completes
   * (WL-0MTIB7JAN004MQ8N). This ensures that an `onExit` refresh triggered
   * by a background command's exit is never silently dropped when another
   * refresh (e.g. from a prior immediate dispatch) is still running.
   *
   * At-most-one trailing refresh: multiple simultaneous refresh requests
   * while in-flight coalesce into a single trailing run, not an unbounded
   * queue (prevents refresh storms).
   */
  let refreshPending = false;

  /**
   * Fetch and apply updated items, with optional notification.
   */
  const doRefresh = async (showNotification = false): Promise<void> => {
    // Typing gate (WL-0MTV67MZU003H7SH): never refresh while a text-input
    // overlay is open — a background re-render would contend with the typing
    // event loop. Skip silently (not coalesced); the next scheduler tick after
    // the overlay closes refreshes normally. Centralised here so it covers ALL
    // callers (scheduler tick, focus-resume, event subscriber, and the
    // command-completion hook), not just the scheduler tick.
    if (inputActive()) return;
    // Single-flight guard with trailing/coalescing: if a refresh is already
    // in-flight, record the request as pending and return. The pending flag
    // is checked in the `finally` block so a trailing refresh runs after the
    // current cycle completes — without unbounded queuing (WL-0MTIB7JAN004MQ8N).
    if (refreshInFlight) {
      refreshPending = true;
      return;
    }
    refreshInFlight = true;
    // ONE in-process SQLite connection for this whole refresh, shared by the
    // expanded-children and actionable-count reads and released in the
    // `finally` below (WL-0MV6C6SLB005HX7B). Opening a fresh WorklogDatabase
    // per helper ran the synchronous open + pragmas + DDL twice per refresh
    // on the event loop (~46–70 ms each on a large worklog.db); a scope
    // bounds the blocking cost at one open. Never reused across a refresh
    // boundary — the no-stale-cache invariant (WL-0MV5CBQ6L005SPAG) is
    // preserved by closing per refresh.
    const refreshScope = createInProcessRefreshScope();
    try {
      try {
        // Fetch the new top-level items and the children of currently
        // expanded parents in PARALLEL, then apply both in one synchronous
        // refreshItems step. The fetcher returns fresh top-level objects
        // without `children`, so a swap followed by an async children
        // re-fetch would render a collapsed intermediate state — the
        // "momentary collapse" flicker (WL-0MSBVBNGH002RDP5). Fetching
        // children up front removes that window entirely; refreshItems also
        // carries over previously fetched children as a safety net when a
        // children re-fetch fails.
        const expanded = [...state.expandedItems];
        const freshChildren = new Map<string, WorkItem[]>();
        // Depth derived from each item's hierarchy position so nested expanded
        // items re-fetch their children at the correct depth
        // (WL-0MSQ3FH1K000MMJW). All expanded parents' children are fetched in
        // ONE batched read (WL-0MV5CBQ6L005SPAG) instead of one `wl` spawn per
        // parent, which was the dominant cold-refresh cost on wide trees.
        const depthByParent = new Map(
          expanded.map((id) => [id, state.getItemDepth(id) + 1]),
        );
        // Start the ITEM fetch first: on the default view it issues the ONE
        // consolidated `wl worklist` read (WL-0MVI0IT4S0070G78), and the
        // review-queue state below then derives from that same in-flight
        // bundle instead of spawning the review query again. Starting the
        // review state first would leave it with nothing to derive from and
        // re-introduce a second `wl` spawn per tick.
        const itemsPromise = fetchItemsForView(
          state.activeFilter,
          state.activePriorityFilter,
          fetcher,
          state.activeDispatchFilter,
          opts.cwd,
        );
        // The banner state read: derived from the consolidated bundle on the
        // default view (no extra spawn); filtered/dispatch views keep their
        // own reads and fall back to the standalone review query.
        const reviewStatePromise = fetchReviewQueueState();
        const childrenPromise = fetchChildrenForItems(expanded, depthByParent, refreshScope)
          .then((childrenByParent) => {
            for (const [parentId, children] of childrenByParent) {
              freshChildren.set(parentId, children);
            }
          })
          .catch(() => {
            // Ignore: refreshItems carries over the previously fetched
            // children when the re-fetch fails.
          });
        const [newItems] = await Promise.all([itemsPromise, childrenPromise]);
        const oldLen = state.items.length;

        // Attach freshly fetched children to the new parent objects BEFORE
        // the swap so the flattened view is complete at render time.
        // Walks the whole tree (top-level + nested children) because
        // expandedItems may contain items at any depth: a nested parent is
        // not in the top-level id→item map, so without the walk its fresh
        // grandchildren would be dropped and the nested expansion would
        // collapse on refresh (WL-0MSQ3FH1K000MMJW AC-4).
        if (freshChildren.size > 0) {
          const attachFresh = (list: WorkItem[]): void => {
            for (const item of list) {
              const fresh = freshChildren.get(item.id);
              if (fresh) {
                item.children = fresh;
              }
              if (item.children && item.children.length > 0) {
                attachFresh(item.children);
              }
            }
          };
          for (const topLevel of newItems) {
            attachFresh([topLevel]);
          }
        }
        // Pane-based active marker (WL-0MV1BWETT005GSUJ): items with a
        // matching pane title in this workspace are shown in-progress even
        // when the worklog status is still `open` (e.g. a claim that was
        // released before the pane was (re)opened). Fail-open.
        await applyPaneMarkers(newItems);
        state.refreshItems(newItems);
        // Refresh the assignee-hold account from the window we just fetched
        // (WL-0MVR8FN1D002SCIR): no extra `wl` spawn, and the shared
        // classifier keeps the TUI in step with the coordination log's
        // `all-window-items-held` token.
        applyAssigneeHoldState(newItems);
        // Blocked-by rows survive refreshes (WL-0MV8Q5X8U004KKAP): the
        // blocker cache is keyed by item ID and invalidated per item only
        // when its payload signature changes (status/stage/updatedAt — see
        // blockerSignature above), so an unrelated refresh reuses the last
        // resolved rows instead of re-running the async lookup and dropping
        // the `Blocked By` line for a frame (the endless flicker fix). A
        // dependency edge change reconciles the from-item's status and
        // bumps updatedAt, so the very next refresh invalidates that item.
        // Re-read the Code Freeze marker so a freeze that started (or ended)
        // since the last refresh is reflected in the banner promptly.
        refreshFreezeState();
        // Refresh the review-queue-depth banner indicator (display-only;
        // completed+in_review root count vs browseItemCount, plus whether any
        // of those items still has an outstanding audit — this drives the
        // banner copy; AH-0MUDYTQ55002NUSJ). Fail-closed: query failure leaves
        // state unchanged. Queue depth never writes the disable marker
        // (WL-0MTTSWC1X005P4VD).
        applySprintState(await reviewStatePromise);
        // The pane-existence marker (in-progress status + green-circle icon)
        // was already applied to `newItems` above by `applyPaneMarkers`; the
        // row icons are pane-title existence, not the event-driven agent
        // tracker (WL-0MV1BWETT005GSUJ). No separate agent merge runs here.
        if (showNotification && newItems.length !== oldLen) {
          const diff = newItems.length - oldLen;
          const msg = diff > 0 ? `+${diff} new` : `${diff} removed`;
          showToast('Refreshed', { body: msg });
        } else if (showNotification) {
          showToast('Refreshed');
        }
      } catch {
        showToast('Refresh failed');
      }
      // Also fetch the total actionable count on refresh — read via the SAME
      // shared in-process connection as the expanded children, so the whole
      // refresh pays exactly one open (WL-0MV6C6SLB005HX7B).
      fetchActionableCount(refreshScope).then((count) => {
        totalActionableCount = count;
      }).catch(() => {
        // ignore
      });
      render();
    } finally {
      // Release the shared in-process connection. Idempotent; a pending
      // fire-and-forget actionable-count read defers the actual close until
      // it settles, so the read never touches a closed handle
      // (WL-0MV6C6SLB005HX7B).
      refreshScope.close();
      // Always clear the guard — a successful, failed, or aborted cycle must
      // never block the next refresh tick.
      refreshInFlight = false;
      // Trailing/coalescing refresh (WL-0MTIB7JAN004MQ8N): if a refresh was
      // requested while this cycle was in-flight, run it now. The flag is
      // reset before the recursive call to prevent infinite loops — only one
      // trailing run per in-flight cycle.
      if (refreshPending) {
        refreshPending = false;
        void doRefresh(false);
      }
    }
  };

  // Wire the completion-triggered refresh hook (WL-0MT1KB70U0012X6T):
  // background (no-pane) shortcut dispatches receive this callback so their
  // child's 'exit' event can trigger a refresh of the current view. The
  // callback is fire-and-forget and non-blocking — doRefresh has its own
  // single-flight guard and never blocks the TUI event loop or the
  // dispatched command's own execution. Scoped to this TUI instance (no
  // global watcher, no cross-instance effects).
  opts.onRefresh = opts.onRefresh ?? (() => doRefresh(false));

  // `isWlViewCommand` is the module-level exported helper (see above); it
  // recognises the stage/priority/dispatches view commands and the bare
  // clear-filter `/wl`.

  // True when a command modifies the work-item data set (close, delete,
  // update, search), warranting an immediate list refresh so the
  // selection list reflects the change without waiting for the auto-refresh
  // cycle (WL-0MTA217DZ003H5K8).
  const isWlModifyingCommand = (cmd: string): boolean => {
    // Commands like "!!wl close <id>", "!!wl delete <id>", "!!wl update <id> ...",
    // "!!wl reviewed <id> ...", "!!wl search ..."
    if (/^!!\s*wl\s+(close|delete|update|reviewed|search)\b/i.test(cmd)) return true;
    return false;
  };

  // Run `wl sync` and surface the outcome as a toast so sync status is
  // visible (success and graceful failure). Targets the resolved worklog
  // directory so sync operates on the tab project.
  //
  // With ifIdle=true (auto-sync timer path) runSync applies its single-flight
  // guard and passes --if-idle to the CLI, so overlapping syncs are skipped
  // instead of piling up (lock-storm prevention). With a heartbeatTtlMs the
  // auto-sync path ALSO skips without spawning when another pane synced
  // recently (cross-instance coordination, F3 — WL-0MSGAEJQA005QG3W); such
  // skips are silent because the data is already fresh. The manual 'S' sync
  // binding was removed (WL-0MSGG5N5Z0074TLY) — doSync is now reached only
  // from the auto-sync timer path.
  const doSync = async (ifIdle = false, heartbeatTtlMs?: number): Promise<void> => {
    // Typing gate (WL-0MTV67MZU003H7SH): never spawn `wl sync` while a
    // text-input overlay is open. Skip silently; the next tick after the
    // overlay closes syncs normally.
    if (inputActive()) return;
    const outcome = await runSync(getWorklogDir(), {
      ifIdle,
      ...(heartbeatTtlMs !== undefined ? { heartbeat: true, heartbeatTtlMs } : {}),
    });
    if (outcome.skipped) {
      // Heartbeat skip: another pane synced within the window — silent.
      if (outcome.reason === 'heartbeat') return;
      // Another sync is already in-flight / holding the lock — do not pile on.
      showToast('Sync in progress');
      return;
    }
    if (outcome.success) {
      showToast('Synced');
    } else {
      showToast('Sync failed', { body: outcome.error ?? 'unknown error' });
    }
  };

  /**
   * Open the Ship It confirmation dialog (WL-0MSGG5N5Z0074TLY).
   *
   * The dev→main release shortcut requires the user to type `ship`
   * (case-insensitive) and press Enter before the command is dispatched.
   * Dispatch (on confirm) goes through the SAME standard command-routing
   * path as every other shortcut — executeResolvedCommand →
   * dispatchChordCommand (which recognizes the `/skill:ship` family) →
   * onCommand — with NO `<id>` substitution (global release). Esc cancels
   * without dispatching.
   */
  const openShipItDialog = (model?: string): void => {
    shipItDialog = new ShipItDialogState(
      // onConfirm — typed 'ship' + Enter: freeze, then dispatch.
      () => {
        // Write the Code Freeze marker BEFORE dispatching `/skill:ship
        // release` so the freeze applies from the moment of confirmation
        // (WL-0MUD6DDZC007ZSIW AC4). When a freeze is ALREADY active the
        // ship skill owns that marker — do not overwrite it, and do not
        // clear it on dispatch failure (the release may already be running).
        const alreadyFrozen = readCodeFreezeState().active;
        const wroteMarker = alreadyFrozen
          ? null
          : writeCodeFreezeMarker({ reason: 'Ship It confirmed in herdr worklist' });
        if (wroteMarker !== null) {
          codeFreezeActive = true;
          refreshFreezeState();
        }
        try {
          // Fresh marker read at dispatch time (fail-safe client-side).
          const frozen = readCodeFreezeState().active;
          if (frozen) {
            codeFreezeActive = true;
          }
          const result = executeResolvedCommand(SHIP_IT_COMMAND, state, opts.onCommand, frozen, model, opts.onDowntimeToggle, undefined, opts.onRefresh);
          if (result === 'noop' || result === 'blocked') {
            // Dispatch was a no-op: best-effort clear the marker WE wrote so
            // a release that never started cannot leave a stale freeze
            // (WL-0MUD6DDZC007ZSIW AC5).
            if (wroteMarker !== null) {
              clearCodeFreezeMarker();
              refreshFreezeState();
            }
            showToast('Skipped', { body: `${SHIP_IT_COMMAND} (no item)` });
          } else {
            showToast('Sent', { body: SHIP_IT_COMMAND });
          }
        } catch (e) {
          // onCommand threw (e.g. no agent pane available): clear the marker
          // WE wrote and surface the error (WL-0MUD6DDZC007ZSIW AC5).
          if (wroteMarker !== null) {
            clearCodeFreezeMarker();
            refreshFreezeState();
          }
          showToast('Error', { body: (e as Error).message });
          process.stderr.write(`[herdr] Command error: ${(e as Error).message}\n`);
        }
      },
      // onCancel — Esc: nothing is dispatched.
      () => {
        // no-op: dialog state is cleared by the onData handler.
      },
    );
    render();
  };

  /**
   * Run the Ship Guard, then open the confirmation dialog — or show the
   * blocked notice (WL-0MUD6DDZC007ZSIW). A live agent pane carrying a
   * project work-item ID blocks ship mode; an unavailable guard query fails
   * safe (no dialog). The dialog is never rendered while blocking panes
   * exist.
   */
  const openShipItDialogGuarded = async (model?: string): Promise<void> => {
    let query: { worklogOutput: string | null; paneOutput: string | null };
    try {
      query = await opts.shipGuardQuery();
    } catch {
      query = { worklogOutput: null, paneOutput: null };
    }
    const queryFailed = query.worklogOutput === null || query.paneOutput === null;
    const result = runShipGuard(query.worklogOutput ?? '', query.paneOutput ?? '');
    if (queryFailed || !result.ok || result.blockingPanes.length > 0) {
      // Pass the guard's reason so the notice names WHICH query failed
      // (worklog vs pane list) rather than a generic message
      // (WL-0MUEK7H39008VVUF AC3).
      blockedNotice = formatBlockedNotice(
        result.blockingPanes,
        queryFailed || !result.ok,
        result.reason,
      );
      shipItDialog = null;
      render();
      return;
    }
    openShipItDialog(model);
  };

  // Double-click state tracker — persists across onData calls for the TUI
  // lifetime. Updated on every left-press so handleMouseInput can detect
  // double-clicks within {@link DOUBLE_CLICK_WINDOW_MS}. (WL-0MSGHM5BQ0096BNJ AC3)
  let clickState: MouseClickState = { lastClick: null, now: 0 };

  // Drag-to-scroll state tracker (WL-0MSI72S0Y0060BRK): persists across
  // onData calls so the drag mapper can accumulate fractional movement
  // and restore the pre-press selection when the drag activates.
  let dragState: MouseDragState = createDragState();

  // ── Mouse event dispatch (WL-0MSGHM5BQ0096BNJ AC2–AC6) ─────────
  // handleMouseInput parses SGR mouse events from the raw chunk BEFORE the
  // keypress path and dispatches them (click select, double-click open,
  // wheel/scroll, filter tap, drag-to-scroll). Mouse-shaped sequences are
  // fully consumed; plain keys and foreign escapes fall through to the
  // keyboard handler untouched (AC6). See the fix note in handleMouseInput
  // for the single-click-select vs double-click-open ordering
  // (WL-0MSZBWT500034E74).
  const dispatchMouse = (key: string): boolean =>
    handleMouseInput(state, key, termSize, clickState, dragState);

  const handleKeyInput = async (key: string): Promise<void> => {

    // Alt+m toggle shortcut (WL-0MT0AP2LR000JFWN): always available,
    // even in modal states. Toggles mouse tracking on/off so the user
    // can use the terminal's native text-selection to copy content.
    if (key === '\x1bm') {
      toggleMouseTracking();
      render();
      return;
    }

    // Try mouse event dispatch first — only runs when the pane is not in a
    // modal state (code-freeze notice, form, ship-it dialog, help overlay),
    // matching the keyboard path. Mouse input is ignored during those modal
    // states.
    if (!codeFreezeNotice && blockedNotice === null && podcastNotice === null && formState === null && shipItDialog === null && state.mode !== 'help') {
      if (dispatchMouse(key)) {
        render();
        return;
      }
    }

    // ── Code Freeze notice handling ─────────────────────────────
    // While the notice is showing, Esc/Enter/q dismiss it and return to the
    // list. All other keys are consumed (the notice is modal). The blocked
    // command is never executed, so no pane is spawned.
    if (codeFreezeNotice) {
      if (key === '\x1b' || key === '\r' || key === '\n' || key === 'q') {
        codeFreezeNotice = false;
      }
      render();
      return;
    }

    // ── Ship-mode blocked notice handling (WL-0MUD6DDZC007ZSIW) ──
    // Shown when `S` was pressed while live agent panes carry project
    // work-item IDs. Modal — Esc/Enter/q dismiss it; no command is
    // dispatched, and the Ship It dialog is never opened while blocking
    // panes exist.
    if (blockedNotice !== null) {
      if (key === '\x1b' || key === '\r' || key === '\n' || key === 'q') {
        blockedNotice = null;
      }
      render();
      return;
    }

    // ── Podcast w-chord dispatch notice handling (OSL-0MUQ59IRF009ICIF) ──
    // Persistent modal surfacing the outcome of a w-r/w-s/w-b dispatch: a
    // refused resolution ("nothing happens") or a successful dispatch. Esc,
    // Enter or q dismisses it and returns to the list; all other keys are
    // consumed so the notice cannot be scrolled away unnoticed.
    if (podcastNotice !== null) {
      if (key === '\x1b' || key === '\r' || key === '\n' || key === 'q') {
        podcastNotice = null;
      }
      render();
      return;
    }

    // ── Form mode handling ──────────────────────────────────────
    if (formState !== null) {
      const result = formState.handleInput(key);
      if (result.type === 'submitted') {
        const resolved = formState.getResult();
        formState = null;
        state.mode = preFormMode;
        // NOTE: dispatch happens inside FormState's onSubmit callback (which
        // resolves <id> placeholders) — do NOT call onCommand again here or
        // every form submission spawns TWO agent panes (WL-0MSAL0RN1009YNJ7).
        showToast('Sent', { body: resolved.length > 60 ? resolved.substring(0, 57) + '...' : resolved });
        render();
      } else if (result.type === 'cancelled') {
        formState = null;
        state.mode = preFormMode;
        render();
      } else if (result.type === 'paste') {
        // Ctrl+V: read the OS clipboard asynchronously (never freezes the
        // TUI), then commit the text verbatim or surface a graceful failure
        // and keep the form open (WL-0MSW6KCTA0092DCV).
        const read = await readFromClipboard();
        if (read.success && read.text !== undefined) {
          formState.pasteText(read.text);
        } else {
          const reason = read.error ?? 'Clipboard read failed';
          formState.notifyPasteFailed(reason);
          showToast('Paste failed', { body: reason });
        }
        render();
      } else if (result.type === 'cut') {
        // Ctrl+X: copy the active field value to the OS clipboard
        // asynchronously and surface feedback. On failure the field value is
        // restored so no data is lost (WL-0MSW6KCTA0092DCV).
        const copy = await writeToClipboard(result.text);
        if (copy.success) {
          showToast('Copied', { body: result.text.length > 40 ? result.text.substring(0, 37) + '...' : (result.text || '(empty)') });
        } else {
          formState.pasteText(result.text);
          showToast('Copy failed', { body: copy.error ?? 'Clipboard unavailable' });
        }
        render();
      } else {
        render();
      }
      return;
    }

    // ── Ship It confirmation dialog handling (WL-0MSGG5N5Z0074TLY) ────
    // While the dialog is open, all keys are consumed by the dialog:
    // printable characters append to the typed buffer, Backspace deletes,
    // Enter submits (dispatching only when the buffer matches `ship`
    // case-insensitively), Esc cancels. The list stays visible beneath the
    // bottom-anchored overlay.
    if (shipItDialog !== null) {
      const result = shipItDialog.handleInput(key);
      if (result === 'submitted' || result === 'cancelled') {
        shipItDialog = null;
      }
      render();
      return;
    }

    // Quit on a bare `q` — but NOT while a chord is pending, because `q`
    // may be the chord's next key (e.g. the `c q` create-quick chord,
    // WL-0MTCLB50D0026YA7). Chord-mode handling below consumes the key
    // when `chordState.pendingKeys` is non-empty. Help mode is handled
    // first (below) so `q` dismisses the overlay instead of quitting.

    // ── Help overlay mode (WL-0MV85R14Y003RII9) ─────────────────
    // Full-pane, display-only overlay. `?`, Esc and `q` dismiss it back to
    // the recorded pre-help mode; scroll keys (j/k/arrow/PageUp/PageDown,
    // g/G) move the content window; every other key is consumed so no
    // command is dispatched and no list state is mutated (2026-10-16 audit:
    // the overlay must be scrollable).
    if (state.mode === 'help') {
      const pageSize = Math.max(5, termSize.rows - 4);
      if (key === '?' || key === '\x1b' || key === 'q') {
        helpScrollOffset = 0;
        state.mode = preHelpMode;
      } else if (key === 'j' || key === '\x1b[B') {
        helpScrollOffset += 1;
      } else if (key === 'k' || key === '\x1b[A') {
        helpScrollOffset = Math.max(0, helpScrollOffset - 1);
      } else if (key === '\x1b[6~') {
        helpScrollOffset += pageSize;
      } else if (key === '\x1b[5~') {
        helpScrollOffset = Math.max(0, helpScrollOffset - pageSize);
      } else if (key === 'g') {
        helpScrollOffset = 0;
      } else if (key === 'G') {
        helpScrollOffset = Number.MAX_SAFE_INTEGER; // clamped in the formatter
      }
      render();
      return;
    }
    // Open the help overlay from the list view. Reserved key `?` (no
    // registry chord, no navigation action) — only offered while help text
    // is enabled, matching the footer hint gate (WL-0MV85QZXN002T51A AC3).
    if (
      state.mode === 'list'
      && key === '?'
      && chordState.pendingKeys.length === 0
      && opts.getShowHelpText()
    ) {
      preHelpMode = state.mode;
      helpScrollOffset = 0;
      state.mode = 'help';
      render();
      return;
    }

    if (key === 'q' && state.mode !== 'filter' && chordState.pendingKeys.length === 0) {
      cleanup();
      resolve(undefined);
      return;
    }

    // ── Chord mode handling ────────────────────────────────────
    if (chordState.pendingKeys.length > 0) {
      // We're in chord mode — process the next key
      const chordResult = processChordInput(
        chordState,
        key,
        shortcutRegistry as ShortcutRegistry,
        state.mode === 'detail' ? 'detail' : 'list',
        state.activeFilter ?? undefined,
        codeFreezeActive,
        state.getSelectedItem()?.issueType,
      );

      if (chordResult === 'chord-complete') {
        // Chord resolved — execute the command
        let command = chordState.resolvedCommand;
        const model = chordState.resolvedModel;
        // openPane: undefined (default) = open a pane; false = background,
        // no pane (WL-0MSJLD1I70045ZUL). Cleared after execution.
        const openPane = chordState.resolvedOpenPane;
        // focus: true = focus the new pane immediately (WL-0MT70LC6B009TL3Q).
        // Omitted/false = current no-focus behavior. Cleared after execution.
        const focus = chordState.resolvedFocus;
        chordState.resolvedCommand = null;
        chordState.resolvedModel = null;
        chordState.resolvedOpenPane = undefined;
        chordState.resolvedFocus = undefined;
        // True when the resolved command carried a podcast-progression marker
        // (OSL-0MUQ59IRF009ICIF): its outcome is surfaced as the persistent
        // podcastNotice instead of the transient 'Sent' toast.
        let podcastMarkerCommand = false;
        if (command) {
          // Podcast-progression markers (<podcast-target>/<podcast-script>/
          // <podcast-review>/<podcast-both>) are resolved from the selected
          // item's context BEFORE the generic modal-form check so they never
          // fall through to the input form (OSL-0MSKFXM380098LFL, folding in
          // OSL-0MSHFQ51L009IUOS; w-chord split OSL-0MSKVB5K6008XFOQ).
          if (command.includes('<podcast-target>') || command.includes('<podcast-script>')
              || command.includes('<podcast-review>') || command.includes('<podcast-both>')) {
            const podcast = await resolvePodcastTarget(command, state.getSelectedItem());
            if (podcast.error) {
              podcastNotice = { kind: 'error', body: podcast.error };
              render();
              return;
            }
            command = podcast.command ?? command;
            podcastMarkerCommand = true;
          }
          // Ship It confirmation (WL-0MSGG5N5Z0074TLY): the dev→main
          // release command, however it reaches this path, requires a typed
          // 'ship' confirmation before dispatch. Esc cancels, the dialog
          // stays bottom-anchored over the list.
          if (command === SHIP_IT_COMMAND) {
            await openShipItDialogGuarded(model ?? undefined);
            return;
          }
          // Inline note-edit chords (WL-0MSKV6SKK008MMXR): add/edit/delete
          // `[NOTE ...]` markers in the md viewer. Scoped to the detail
          // view via shortcuts.json (view: 'detail'), so the `<note_text>`
          // placeholder only reaches this branch from the viewer.
          if (command === '/herdr:note-edit <note_text>'
              || command === '/herdr:note-delete') {
            const mdPaths = state.detailItem
              ? extractFilePaths(state.detailItem.description ?? '')
                  .filter(p => p.endsWith('.md'))
              : [];
            const mdPath = mdPaths[state.detailRenderedIndex] ?? mdPaths[0];
            if (!mdPath) {
              showToast('Note', { body: 'No markdown document in this view.' });
              render();
              return;
            }
            const content = readKeyFile(mdPath);
            if (content == null) {
              showToast('Note', { body: 'Markdown document unreadable.' });
              render();
              return;
            }
            // The visible cursor line (scroll offset) maps to the source
            // paragraph the user has scrolled to.
            const paragraphIndex = mapCursorToParagraph(content, state.detailScrollOffset);
            state.detailNoteCursor = Math.max(0, paragraphIndex);
            const marker = mapParagraphToMarker(content, state.detailNoteCursor);

            // Candidate episodes for PRD §7.3 note-child sync: the selected
            // item (an episode's Key Files include the script) plus the
            // loaded worklist items, deduplicated by id. Empty for generic
            // markdown never invokes `wl` (local placeholder ids only).
            const episodeItems = buildEpisodeCandidates(state);

            if (command === '/herdr:note-delete') {
              if (!marker) {
                showToast('Note', { body: 'No note on this paragraph.' });
                render();
                return;
              }
              const result = await applyNoteEditToFile(
                state.detailItem,
                mdPath,
                { kind: 'remove', noteId: marker.noteId },
                readKeyFile,
                writeKeyFile,
                episodeItems,
              );
              if (result.byteOffset < 0) {
                showToast('Note', { body: 'Delete did not apply.' });
              } else if (result.warning) {
                showToast('Warning', { body: result.warning });
              } else {
                showToast('Note deleted', { body: `${marker.noteId} removed.` });
              }
              render();
              return;
            }

            // Add/edit: open the note-text form, pre-filled in edit mode.
            const existing = marker ? findNoteInParagraph(
              splitParagraphs(content)[state.detailNoteCursor]?.text ?? '',
            ) : null;
            const prefill = existing ? existing.body : '';
            const template = existing
              ? `/herdr:note-edit <note_text default="${prefill.replace(/"/g, '&quot;')}">`
              : '/herdr:note-edit <note_text>';
            const noteId = existing?.id ?? undefined;
            preFormMode = state.mode;
            state.mode = 'form';
            formState = new FormState(
              template,
              'Note text (inline [NOTE <id>: ...] marker, PRD §7.1)',
              getUnknownIdentifiers(template),
              // onSubmit: apply the edit and re-render.
              async (resolved: string) => {
                const textMatch = resolved.match(/note_text[= >]*([\s\S]*)$/);
                const text = (textMatch ? textMatch[1] : resolved).trim();
                formState = null;
                state.mode = preFormMode;
                const action = noteId
                  ? { kind: 'update' as const, noteId, text }
                  : { kind: 'insert' as const, paragraphIndex: state.detailNoteCursor, text };
                const result = await applyNoteEditToFile(
                  state.detailItem,
                  mdPath,
                  action,
                  readKeyFile,
                  writeKeyFile,
                  episodeItems,
                );
                if (result.byteOffset < 0) {
                  showToast('Note', { body: 'Edit did not apply.' });
                } else if (result.warning) {
                  showToast('Warning', { body: result.warning });
                } else {
                  showToast('Note saved', { body: `${result.newNoteId ?? noteId ?? 'marker'} written.` });
                }
                render();
              },
              // onCancel
              () => {
                formState = null;
                state.mode = preFormMode;
              },
            );
            render();
            return;
          }
          // Check for unknown identifiers that need form input
          if (hasUnknownIdentifiers(command)) {
            // Look up description from shortcut entry
            let description = '';
            if (shortcutRegistry) {
              const entries = (shortcutRegistry as ShortcutRegistry).getEntries();
              // Reconstruct the full chord that was just completed
              // The chord key sequences are available from the pending keys
              const matchingEntry = entries.find(e => e.command === command);
              if (matchingEntry && matchingEntry.description) {
                description = matchingEntry.description;
              }
            }
            const unknownIds = getUnknownIdentifiers(command);
            preFormMode = state.mode;
            state.mode = 'form';
            formState = new FormState(
              command,
              description,
              unknownIds,
              // onSubmit: resolve and execute
              (resolved: string) => {
                // Handle <id> resolution
                let finalCmd = resolved;
                if (finalCmd.includes('<id>')) {
                  const selected = state.getSelectedItem();
                  if (selected) {
                    finalCmd = finalCmd.replace(/<id>/g, selected.id);
                  }
                }
                // Record the submitted command against its work item before
                // routing it (WL-0MSEPP104006PS7T).
                logCommandForItem(finalCmd, extractWorkItemIdFromCommand(finalCmd));
                // Code Freeze guard: never submit an implement command while
                // frozen — show the notice instead of dispatching.
                if (readCodeFreezeState().active && isImplementCommand(finalCmd)) {
                  codeFreezeNotice = true;
                  return;
                }
                if (opts.onCommand) {
                  // Forward openPane/onRefresh/focus with the same arity rules
                  // as the placeholder-free paths (invokeOnCommand): a form-
                  // triggered shortcut carrying `open_pane: false` must run in
                  // the background exactly like a placeholder-free one
                  // (WL-0MV6J4HQ0009OJPQ). paneTitle is intentionally not
                  // computed here — the form path has never supplied one, so
                  // pane-opening form dispatches stay byte-compatible with
                  // today's 2-arg call.
                  invokeOnCommand(opts.onCommand, finalCmd, model ?? undefined, openPane, opts.onRefresh, undefined, focus);
                }
              },
              // onCancel
              () => {
                formState = null;
                state.mode = preFormMode;
              },
            );
            render();
            return;
          }

          // No unknown identifiers — execute as before
          try {
            // Fresh marker read at dispatch time: a freeze that started
            // between refreshes is enforced here (fail-safe client-side).
            const frozen = readCodeFreezeState().active;
            if (frozen) {
              codeFreezeActive = true;
            }
            const result = executeResolvedCommand(command, state, opts.onCommand, frozen, model ?? undefined, opts.onDowntimeToggle, openPane, opts.onRefresh, focus);
            if (result === 'blocked') {
              // Code Freeze — show the notice dialog; the command was NOT
              // routed, no pane spawned, no work item claimed.
              codeFreezeNotice = true;
            } else if (podcastMarkerCommand) {
              // Persistent in-pane confirmation (OSL-0MUQ59IRF009ICIF): the
              // resolved podcast command replaces the transient 'Sent' toast.
              podcastNotice = { kind: 'dispatched', body: command };
            } else if (result === 'noop') {
              showToast('Skipped', { body: `${command.length > 60 ? command.substring(0, 57) + '...' : command} (no item)` });
            } else {
              // Surface a brief toast, then continue
              showToast('Sent', { body: command.length > 60 ? command.substring(0, 57) + '...' : command });
            }
            // Stage-filter dispatch (/wl <stage> or f-chord shortcut): refetch
            // so the filtered view shows every root item in the stage matching
            // the stage's status rule, not just the already-loaded subset
            // (WL-0MSDT8X1V003206G).
            // Modifying-command dispatch (close, delete, update,
            // search): refetch so the selection list reflects the change
            // immediately instead of waiting for the auto-refresh cycle
            // (WL-0MTA217DZ003H5K8).
            // Background dispatches (openPane === false) suppress the immediate
            // refresh — the onExit handler (onRefresh) fires after the
            // background command completes and provides the correct freshness
            // point without racing ahead of the data-modifying command
            // (WL-0MTIB7JAN004MQ8N).
            if (result === 'dispatched' && openPane !== false
                && (isWlViewCommand(command) || isWlModifyingCommand(command))) {
              await doRefresh(true);
            }
          } catch (e) {
            showToast('Error', { body: (e as Error).message });
            process.stderr.write(`[herdr] Command error: ${(e as Error).message}\n`);
          }
          render();
          return;
        }
        // No command — fall through to normal handling
      }

      if (chordResult === 'chord-cancel') {
        // Cancel chord, continue in normal mode
        render();
        return;
      }

      // Still collecting chord keys
      render();
      return;
    }

    // ── Normal key handling ────────────────────────────────────
    // Save mode before processing — selectItem() changes mode to 'detail',
    // but we need to distinguish "just entered detail" from "confirm in detail".
    const prevMode = state.mode;
    // Compute the dynamic panel height so metaScrollDown clamps correctly
    // (WL-0MSQ44MDX008U69J). The value is used only for the m/M scroll
    // clamping — the actual rendering is done by createListRenderer.
    const displayItems = state.mode === 'list'
      ? state.getDisplayRows()
      : state.items;
    const bannerCount = (codeFreezeActive ? 1 : 0) + (codeFreezeAmbiguous ? 1 : 0);
    const { panelHeight } = computeDynamicLayout(
      displayItems,
      state.scrollOffset,
      bannerCount,
      termSize,
    );
    const action = handleKeypress(state, key, termSize, panelHeight);

    // If key wasn't handled as navigation and chord registry exists,
    // check if it's a shortcut or part of a chord sequence
    if (shortcutRegistry && (action === null || isChordLeader(key, shortcutRegistry as ShortcutRegistry, codeFreezeActive, state.getSelectedItem()?.issueType))) {
      // First: check if this key is a complete single-key shortcut
      const singleEntry = (shortcutRegistry as ShortcutRegistry).lookupChordEntry(
        [key],
        state.mode === 'detail' ? 'detail' : 'list',
        state.activeFilter ?? undefined,
        codeFreezeActive,
        state.getSelectedItem()?.issueType,
      );
      if (singleEntry) {
        let singleCmd = singleEntry.command;
        const singleModel = singleEntry.model ?? undefined;
        // openPane: undefined (default) = open a pane; false = background,
        // no pane (WL-0MSJLD1I70045ZUL).
        const singleOpenPane = singleEntry.openPane ?? undefined;
        // True when the command carried a podcast-progression marker: its
        // outcome uses the persistent podcastNotice (OSL-0MUQ59IRF009ICIF).
        let singlePodcastMarker = false;
        // Podcast-progression markers (<podcast-target>/<podcast-script>/
        // <podcast-review>/<podcast-both>) are resolved from the selected
        // item's context BEFORE the generic modal-form check so they never
        // fall through to the input form (OSL-0MSKFXM380098LFL, folding in
        // OSL-0MSHFQ51L009IUOS; w-chord split OSL-0MSKVB5K6008XFOQ).
        if (singleCmd.includes('<podcast-target>') || singleCmd.includes('<podcast-script>')
            || singleCmd.includes('<podcast-review>') || singleCmd.includes('<podcast-both>')) {
          const podcast = await resolvePodcastTarget(singleCmd, state.getSelectedItem());
          if (podcast.error) {
            podcastNotice = { kind: 'error', body: podcast.error };
            render();
            return;
          }
          singleCmd = podcast.command ?? singleCmd;
          singlePodcastMarker = true;
        }
        // Ship It (S) — typed-confirmation dialog (WL-0MSGG5N5Z0074TLY):
        // the dev→main release shortcut does NOT dispatch immediately. It
        // opens a bottom-anchored confirmation dialog that keeps the
        // selection list visible; the user must type `ship` + Enter to
        // dispatch, Esc to cancel.
        if (singleCmd === SHIP_IT_COMMAND) {
          await openShipItDialogGuarded(singleModel);
          return;
        }
        // Single-key shortcut — check for unknown identifiers first
        if (hasUnknownIdentifiers(singleCmd)) {
          let description = '';
          if (singleEntry.description) {
            description = singleEntry.description;
          }
          const unknownIds = getUnknownIdentifiers(singleCmd);
          preFormMode = state.mode;
          state.mode = 'form';
          formState = new FormState(
            singleCmd,
            description,
            unknownIds,
            (resolved: string) => {
              let finalCmd = resolved;
              if (finalCmd.includes('<id>')) {
                const selected = state.getSelectedItem();
                if (selected) {
                  finalCmd = finalCmd.replace(/<id>/g, selected.id);
                }
              }
              // Record the submitted command against its work item before
              // routing it (WL-0MSEPP104006PS7T).
              logCommandForItem(finalCmd, extractWorkItemIdFromCommand(finalCmd));
              // Code Freeze guard: never submit an implement command while
              // frozen — show the notice instead of dispatching.
              if (readCodeFreezeState().active && isImplementCommand(finalCmd)) {
                codeFreezeNotice = true;
                return;
              }
              if (opts.onCommand) {
                opts.onCommand(finalCmd, singleModel);
              }
            },
            () => {
              formState = null;
              state.mode = preFormMode;
            },
          );
          render();
          return;
        }

        // Single-key shortcut — execute immediately and keep TUI alive
        try {
          // Fresh marker read at dispatch time (fail-safe client-side).
          const frozen = readCodeFreezeState().active;
          if (frozen) {
            codeFreezeActive = true;
          }
          // Focus (WL-0MT70LC6B009TL3Q): single-entry focus flag (only `P n` sets true today).
          const singleFocus = singleEntry.focus ?? undefined;
          const result = executeResolvedCommand(singleCmd, state, opts.onCommand, frozen, singleModel, opts.onDowntimeToggle, singleOpenPane, opts.onRefresh, singleFocus);
          if (result === 'blocked') {
            // Code Freeze — show the notice dialog; no pane spawned.
            codeFreezeNotice = true;
          } else if (singlePodcastMarker) {
            // Persistent in-pane confirmation (OSL-0MUQ59IRF009ICIF).
            podcastNotice = { kind: 'dispatched', body: singleCmd };
          } else {
            // Surface a brief toast, then continue
            showToast('Sent', { body: singleCmd.length > 60 ? singleCmd.substring(0, 57) + '...' : singleCmd });
          }
          // Stage-filter dispatch (/wl <stage> or f-chord shortcut): refetch
          // so the filtered view shows every root item in the stage matching
          // the stage's status rule, not just the already-loaded subset
          // (WL-0MSDT8X1V003206G).
          // Modifying-command dispatch (close, delete, update,
          // search): refetch so the selection list reflects the change
          // immediately instead of waiting for the auto-refresh cycle
          // (WL-0MTA217DZ003H5K8).
          // Background dispatches (singleOpenPane === false) suppress the
          // immediate refresh — the onExit handler (onRefresh) fires after
          // the background command completes and provides the correct
          // freshness point without racing ahead of the data-modifying
          // command (WL-0MTIB7JAN004MQ8N).
          if (result === 'dispatched' && singleOpenPane !== false
              && (isWlViewCommand(singleCmd) || isWlModifyingCommand(singleCmd))) {
            await doRefresh(true);
          }
          render();
        } catch (e) {
          showToast('Error', { body: (e as Error).message });
          process.stderr.write(`[herdr] Shortcut error: ${(e as Error).message}\n`);
          render();
        }
        return;
      }

      // Second: check if this key starts a multi-key chord sequence
      if (isChordLeader(key, shortcutRegistry as ShortcutRegistry, codeFreezeActive, state.getSelectedItem()?.issueType)) {
        const nextChords = (shortcutRegistry as ShortcutRegistry).getChordByPrefix([key],
          state.mode === 'detail' ? 'detail' : 'list',
          state.activeFilter ?? undefined,
          codeFreezeActive,
          state.getSelectedItem()?.issueType);
        if (nextChords.length > 0) {
          chordState.pendingKeys = [key];
          chordState.hints = formatChordHintsForHelp(nextChords, [key]);
          chordState.resolvedCommand = null;
          chordState.resolvedModel = null;
          chordState.resolvedOpenPane = undefined;
          chordState.resolvedFocus = undefined;
          render();
          return;
        }
      }
    }

    if (action === 'refresh') {
      await doRefresh(true);
      return;
    }

    if (action === 'select' && prevMode === 'list' && state.detailItem?.isLogDerived) {
      // Enter on a log-derived dispatch row (WL-0MUL2J15W00277XH): open the
      // detail view immediately from the log metadata, then best-effort
      // fetch the live item and upgrade in place when it still exists. A
      // closed/deleted item keeps the log-derived metadata — never blank.
      render();
      await resolveDispatchDetail(state);
      render();
      return;
    }

    if (action === 'select' && prevMode === 'detail') {
      cleanup();
      resolve(state.detailItem ?? undefined);
      return;
    }

    if (action === 'toggle-expand' && state.mode === 'list') {
      const selected = state.getSelectedItem();
      if (selected) {
        // If children data not yet loaded, fetch them on demand
        if (selected.childCount && selected.childCount > 0 && (!selected.children || selected.children.length === 0)) {
          render(); // immediate render while fetch is pending
          // Depth derived from the selected item's hierarchy position so
          // grandchildren of a nested item fetch at depth N+1, not 1
          // (WL-0MSQ3FH1K000MMJW).
          const children = await fetchChildrenForItem(selected.id, (selected.depth ?? 0) + 1);
          // Attach to the live tree object so the fetched grandchildren
          // survive the flatten (which may hold a copy with a corrected
          // depth) — see WorkItemListState.attachChildren.
          state.attachChildren(selected.id, children);
          // The pane-existence marker recurses into children, so newly
          // expanded children pick up their green-circle / in-progress
          // markers on the next pane-marker pass (the 30 s cadence or the
          // next refresh) — same behaviour as the status marker
          // (WL-0MV1BWETT005GSUJ).
          state.toggleExpand(selected.id);
          render();
          return;
        }
      }
    }

    // Re-render
    render();
  };

  // ── Streaming stdin decode (WL-0MTV67MZU003H7SH) ──────────────────
  // Raw TTY input is a byte stream: a multi-byte UTF-8 code point or a
  // mouse/paste/arrow escape sequence can be split across `data` events while
  // typing fast. `KeypressDecoder` buffers the incomplete tail and completes
  // it from the next chunk (never dropping bytes, never misreading a split
  // escape as the Esc key). Complete keys are dispatched through the SAME
  // handler as before, one decoded chunk at a time.
  const keyDecoder = new KeypressDecoder();
  const onData = (chunk: Buffer): void => {
    const keys = keyDecoder.push(chunk);
    if (keys.length === 0) return;
    void handleKeyInput(keys.join(''));
  };

  let resolve: (value: WorkItem | undefined) => void;
  /**
   * True once exit has been requested and the TUI promise has resolved.
   * Async work still in flight at exit time (a refresh cycle, its coalesced
   * trailing refresh, a single-flight blocker re-resolve) resolves afterwards
   * and calls `render()`. Writing a frame to a terminal whose pane has already
   * been torn down is a leak: it can corrupt a reused pane and, in tests, the
   * escaping frame is captured by whoever owns stdout next
   * (WL-0MVFX6404003TE2E). `render()` therefore becomes a no-op after exit.
   */
  let exited = false;
  const promise = new Promise<WorkItem | undefined>((res) => {
    resolve = (value: WorkItem | undefined) => {
      exited = true;
      res(value);
    };
  });

  /**
   * Read a Key Files: markdown document (e.g. an episode .podcast.md) for
   * the generic md viewer in the detail pane. Paths are resolved against
   * the worklog root (via resolveKeyFilePath) — the plugin pane's process
   * CWD is the plugin source dir, not the worklog root
   * (WL-0MSGEA9AY0080V4Q). Fail-open: unreadable or missing files yield
   * null and the detail view falls back to the raw description.
   */
  const readKeyFile = (filePath: string): string | null => {
    const resolved = resolveKeyFilePath(filePath);
    if (!resolved) return null;
    try {
      return readFileSync(resolved, 'utf-8');
    } catch {
      return null;
    }
  };

  /**
   * Write a Key Files: markdown document back to disk (WL-0MSKV6SKK008MMXR
   * note-edit write-back). Path resolution mirrors `readKeyFile`
   * (resolveKeyFilePath against the worklog root); a missing resolved path
   * is a silent no-op so the TUI never crashes on a stale Key Files entry.
   */
  const writeKeyFile = (filePath: string, content: string): void => {
    const resolved = resolveKeyFilePath(filePath);
    if (!resolved) return;
    try {
      writeFileSync(resolved, content, 'utf-8');
    } catch (error) {
      process.stderr.write(`[herdr] Note write-back failed: ${String(error)}\n`);
    }
  };

  /**
   * Build the command list shown in the `?` help overlay (WL-0MV85R14Y003RII9).
   *
   * Derived live from the ShortcutRegistry for the selected item's stage and
   * issue type, so a future shortcut appears automatically. Mirrors the
   * footer's list-view filter (`view === 'list' | 'both'`); unlike the footer
   * it never collapses a chord family — the overlay enumerates every entry.
   */
  const buildHelpEntries = (): ShortcutEntry[] => {
    if (!shortcutRegistry) return [];
    const reg = shortcutRegistry as ShortcutRegistry;
    const displayItems = state.getDisplayRows();
    const selIdx = state.selectedIndex;
    const selItem = displayItems.length > 0 && selIdx < displayItems.length
      ? displayItems[selIdx]
      : undefined;
    const selStage = selItem !== undefined && !isHeadingRow(selItem) ? selItem.stage : undefined;
    const selIssueType = selItem !== undefined && !isHeadingRow(selItem) ? selItem.issueType : undefined;
    return reg
      .getEntriesForStage(selStage, codeFreezeActive, selIssueType)
      .filter(e => e.view === 'list' || e.view === 'both');
  };

  /**
   * Build the icon legend shown in the `?` help overlay (WL-0MV85R2G6000G7BU).
   * Rows come from the shared `ICON_LEGEND` (the single icon source of truth)
   * so a newly added row glyph cannot silently miss the legend — the drift
   * guard in packages/shared/src/icons-legend.test.ts enforces it.
   */
  const buildHelpIconLegend = (): HelpIconRow[] =>
    ICON_LEGEND.map((entry) => ({
      category: entry.category,
      glyph: entry.glyph,
      meaning: entry.meaning,
    }));

  const render = (): void => {
    // Never write a frame after teardown: async work that outlives the exit
    // (refresh cycle / coalesced trailing refresh / blocker re-resolve) must
    // not repaint a torn-down pane (WL-0MVFX6404003TE2E).
    if (exited) return;
    termSize = getTermSize();
    state.termSize = termSize;

    // ── Form overlay rendering ─────────────────────────────────
    if (formState !== null) {
      const formOutput = formState.render(termSize.cols, termSize.rows);
      process.stdout.write(ANSI.clear);
      process.stdout.write(ANSI.cursorHome);
      process.stdout.write(formOutput);
      return;
    }

    // ── Code Freeze notice overlay rendering ───────────────────
    // Shown when an implement command was attempted during a freeze. The
    // freeze reason (if any) comes from the marker for a helpful message.
    if (codeFreezeNotice) {
      const freezeReason = readCodeFreezeState().reason;
      const dialogOutput = formatCodeFreezeDialog(termSize.cols, termSize.rows, freezeReason);
      process.stdout.write(ANSI.clear);
      process.stdout.write(ANSI.cursorHome);
      process.stdout.write(dialogOutput);
      return;
    }

    // ── Ship-mode blocked notice overlay rendering ─────────────
    // Shown when `S` was pressed while live agent panes carry project
    // work-item IDs (WL-0MUD6DDZC007ZSIW). Full-pane modal — the Ship It
    // dialog is never rendered while this notice is showing.
    if (blockedNotice !== null) {
      const dialogOutput = formatBlockedShipDialog(termSize.cols, termSize.rows, blockedNotice);
      process.stdout.write(ANSI.clear);
      process.stdout.write(ANSI.cursorHome);
      process.stdout.write(dialogOutput);
      return;
    }

    // ── Podcast w-chord dispatch notice overlay rendering ──────
    // Persistent modal for a w-r/w-s/w-b dispatch outcome
    // (OSL-0MUQ59IRF009ICIF). Rendered above the list so a refused dispatch
    // is impossible to miss; the operator dismisses it with Esc/Enter/q.
    if (podcastNotice !== null) {
      const dialogOutput = formatPodcastNotice(termSize.cols, termSize.rows, podcastNotice);
      process.stdout.write(ANSI.clear);
      process.stdout.write(ANSI.cursorHome);
      process.stdout.write(dialogOutput);
      return;
    }

    // ── Help overlay rendering (WL-0MV85R14Y003RII9) ──────────
    // Full-pane, read-only `?` help screen: every list-view shortcut
    // (grouped by chord leader) plus the icon legend, clipped to the
    // `rows - 1` budget with the dismiss footer always visible, and a
    // scrollable content window (2026-10-16 audit). Nothing is
    // dispatched and no list state is read or mutated beyond the registry.
    if (state.mode === 'help') {
      const helpEntries = buildHelpEntries();
      const helpOutput = formatHelpScreen(
        helpEntries,
        termSize.cols,
        termSize.rows,
        buildHelpIconLegend(),
        helpScrollOffset,
      );
      process.stdout.write(ANSI.clear);
      process.stdout.write(ANSI.cursorHome);
      process.stdout.write(helpOutput);
      return;
    }

    // Use the display-rows model for list rendering (headings + items,
    // WL-0MSL5MPSZ003TG94). Heading rows have no stage/issueType, so
    // shortcut hints fall back to defaults for heading selections.
    const displayItems = state.mode === 'list' ? state.getDisplayRows() : state.items;

    // ── Compute stage-appropriate shortcut hints for the footer ──
    let dynamicHints = '';
    if (shortcutRegistry && chordState.pendingKeys.length === 0) {
      const reg = shortcutRegistry as ShortcutRegistry;
      const selIdx = state.selectedIndex;
      const selItem = displayItems.length > 0 && selIdx < displayItems.length
        ? displayItems[selIdx]
        : undefined;
      // Narrow the display-row union: heading rows carry no work-item
      // fields (stage/issueType belong to WorkItem rows only).
      const selStage =
        selItem !== undefined && !isHeadingRow(selItem) ? selItem.stage : undefined;
      const selIssueType =
        selItem !== undefined && !isHeadingRow(selItem) ? selItem.issueType : undefined;
      const isEmpty = displayItems.length === 0;

      const relevantEntries = reg.getEntriesForStage(selStage, codeFreezeActive, selIssueType)
        .filter(e => e.view === 'list' || e.view === 'both')
        .filter(e => {
          if (isEmpty && e.command.includes('<id>')) return false;
          return true;
        });

      if (relevantEntries.length > 0) {
        dynamicHints = formatFooterShortcutHints(relevantEntries);
      }
    }

    // Look up the selected item's last recorded command for the metadata
    // panel (only shown for actively-worked, status in-progress items). Best
    // effort: a missing or unreadable log yields undefined and the panel falls
    // back gracefully.
    const metaLastCommand = state.mode === 'list'
      ? resolveMetaLastCommand(state.getSelectedItem())
      : undefined;

    // Active dependency blockers for the metadata panel's `Blocked By` rows
    // (WL-0MV8EZRDJ001TDA8). Cached/async; the render path never blocks.
    const metaBlockers = state.mode === 'list'
      ? resolveMetaBlockers(state.getSelectedItem())
      : undefined;
    // Keep the state's `m`/`M` scroll clamp in sync with the rows the
    // renderer will actually show.
    state.metaBlockedBy = metaBlockers ?? null;
    // Detail view: the SAME single-flight + signature-keyed cache resolves
    // the detail item's active blockers so `formatDetailContent` can render
    // `Blocked By` rows without re-opening the WL-0MV8Q5X8U004KKAP flicker
    // class (WL-0MVBMLY2Z0032CYR). Sharing the per-item cache/in-flight memo
    // means a detail lookup never duplicates a preview lookup for the same
    // item: mode switches between the two surfaces reuse the resolved rows.
    const detailBlockers = state.mode === 'detail'
      ? resolveMetaBlockers(state.detailItem)
      : undefined;
    // Keep the detail scroll-bounds calculation in sync with the rows the
    // renderer will actually show (detailScrollDown clamp, WL-0MVBMLY2Z0032CYR).
    state.detailBlockedBy = detailBlockers ?? null;

    // ── Hover tooltip (WL-0MT9XRZDK006GMUH) ────────────────────────
    // Build the tooltip lines for the currently hovered row when it is a
    // work item with an associated agent-pane and the tooltip has not been
    // dismissed by Esc. Fail-open: any lookup error yields no tooltip.
    let hoverTooltipLines: string[] | undefined;
    if (state.mode === 'list' && !state.tooltipDismissed && state.hoveredRowIndex !== null) {
      try {
        const rows = state.getDisplayRows();
        const row = rows[state.hoveredRowIndex];
        if (row !== undefined && !isHeadingRow(row)) {
          const entry = agentTracker?.getEntry(row.id) ?? undefined;
          if (entry) {
            hoverTooltipLines = formatTooltipLines(
              row,
              entry.command,
              entry.recordedAt,
              termSize.cols,
              !opts.showIcons,
            );
          }
        }
      } catch {
        // Fail-open: never let a tooltip lookup break rendering.
      }
    }

    const output = renderer(
      displayItems,
      state.selectedIndex,
      state.scrollOffset,
      termSize,
      state.activeFilterLabel,
      state.mode,
      state.detailItem,
      totalActionableCount,
      chordState,
      state.detailScrollOffset,
      opts.autoRefresh,
      state.expandedItems,
      opts.getShowHelpText() ? dynamicHints : undefined,
      state.navigationStack.depth,
      panePaused,
      codeFreezeActive,
      state.metaScrollOffset,
      metaLastCommand,
      readKeyFile,
      renderDowntimeStatus(opts.downtimeWorker),
      state.detailToCIndex,
      state.detailToCFocus,
      state.detailRenderedIndex,
      // Gate the chord-in-progress footer behind showHelpText so `false` hides
      // ALL shortcut hint lines (normal and chord-mode), matching the pi browse
      // widget (WL-0MSGJDSMJ004128E). Chord key handling is unaffected.
      opts.getShowHelpText(),
      // Ambiguous code-freeze marker banner state (WL-0MSQ0RPQP00636JY):
      // distinct from the active-freeze banner; both can render (defensive)
      // but the tri-state read guarantees at most one is true.
      codeFreezeAmbiguous,
      // Hover tooltip lines for the footer overlay (WL-0MT9XRZDK006GMUH).
      hoverTooltipLines,
      // Review-queue-depth banner state (parent WL-0MTHSHN5V008R5L0).
      sprintComplete,
      sprintCompletedCount,
      loadSettings().browseItemCount ?? opts.browseItemCount,
      // Outstanding-audit flag driving the banner copy (AH-0MUDYTQ55002NUSJ).
      sprintAuditsOutstanding,
      metaBlockers,
      detailBlockers,
      syncNoticeText,
      // Assignee scheduling-hold surface (AC1 header count + AC2 banner):
      // display-only, read-only — the holds are never cleared here.
      assigneeHoldStatusText(assigneeHoldSummary),
      assigneeHoldBannerText(assigneeHoldSummary),
    );

    // Notifications are surfaced via Herdr toasts (showToast), never as a
    // bottom line — the pane output must stay within the terminal budget.
    const rendered = output;

    // ── Ship It confirmation dialog overlay (WL-0MSGG5N5Z0074TLY) ─────
    // Bottom-anchored: the selection list is rendered normally and the
    // dialog replaces only the lower rows, so the list stays visible above
    // it (contrast: FormState full-screen, Code Freeze notice centered
    // full-pane box). The overlay never exceeds the `rows - 1` budget.
    const finalOutput = shipItDialog !== null
      ? overlayShipItDialog(rendered, termSize.cols, termSize.rows, shipItDialog.buffer)
      : rendered;

    // Clear from cursor to end of screen to remove leftover content
    // from previous renders of different heights
    process.stdout.write(ANSI.clear);
    process.stdout.write(ANSI.cursorHome);
    process.stdout.write(finalOutput);
  };

  // Initial render
  render();

  // Handle resize events
  const onResize = (): void => {
    termSize = getTermSize();
    state.termSize = termSize;
    render();
  };

  process.stdout.on('resize', onResize);

  // Read keypresses
  process.stdin.on('data', onData);

  // ── Consolidated scheduler loop (WL-0MSG4NMF0000YBRP) ──────────────
  // All periodic plugin work — auto-refresh, auto-sync, visibility
  // resume-poll, and future downtime-worker ticks — runs through ONE
  // TaskScheduler interval. Tasks are dispatched by due-time deadline at a
  // 1s base tick; each task applies its own visibility gate (refresh/sync
  // skip when hidden, resume-poll only runs while hidden). Tick cadence,
  // pause-when-hidden gating, and shutdown cleanup live in one place.
  const scheduler = new TaskScheduler(DEFAULT_SCHEDULER_TICK_MS);

  // ── Hydrator (WL-0MSOJLZD9004P8PI) ──────────────────────────────────
  // Self-heals the queue: periodically re-checks `in_progress` items against
  // the current workspace's item-ID tabs and releases (demotes) any item
  // claimed with no matching tab. Visibility-gated via
  // createHydratorRunner, so a hidden tab spawns zero `wl`/`herdr`
  // processes (AC5). The SAME runner is invoked immediately on the
  // hidden→visible resume below, so regaining focus re-checks without
  // waiting for the next 30 s tick (AC4).
  const runHydrator = createHydratorRunner(createProductionHydratorDeps(), {
    workspaceId: process.env.HERDR_WORKSPACE_ID ?? undefined,
    isVisible: () => paneGate.visible(),
  });

  // DB-change tracker: detects whether the worklog DB has changed since the
  // last cycle. Used to gate auto-refresh/sync ticks so idle panes spawn
  // zero wl processes (WL-0MSJ1OLTL009N4IQ). Created only when we can
  // resolve the worklog dir (set via fetcher.setWorklogDir()); otherwise
  // the gate is effectively disabled (fail-open: all ticks run).
  const worklogDir = getWorklogDir();
  const tracker = worklogDir
    ? new DbChangeTracker(resolveCacheDir(), worklogDir)
    : null;

  const stopResumePoll = (): void => {
    scheduler.setDisabled('resume-poll', true);
  };

  /** Start the resume poll (no-op when already running). */
  const startResumePoll = (): void => {
    scheduler.setDisabled('resume-poll', false);
  };

  /**
   * Whether the resume-poll fallback should run. The resume-poll is only
   * the FALLBACK for the hidden → visible transition — when the event
   * subscription is active, `pane_focused` events handle it instead, so the
   * polling task stays disabled (WL-0MSHB7DHO004RHBJ F3).
   */
  const resumePollEnabled = (): boolean => !eventsActive;

  // Auto-refresh task — fetches fresh items on an interval. NOTE: this task
  // does NOT run `wl sync`; the dedicated sync task below is the single sync
  // source. Running sync from both tasks caused a double-spawn per pane that
  // amplified the wl sync lock storm (WL-0MSAB7ZUC004SK7E).
  // Visibility-gated: when the pane is hidden (not focused), ticks are
  // skipped so hidden panes spawn zero wl processes (pause-when-hidden).
  // Typing-gated (WL-0MTV67MZU003H7SH): while any text-input overlay is open
  // (`isInputActive()`), the tick is skipped so keypresses aren't dropped by
  // a concurrent re-render. md-note-edit is already covered — it opens a
  // FormState, so `formState !== null` suffices for every current input site.
  // Resume contract: skip silently, don't coalesce; the next regular tick
  // after the overlay closes fires normally (no queued immediate refresh).
  if (opts.autoRefresh) {
    scheduler.addTask({
      id: 'refresh',
      intervalMs: opts.refreshIntervalMs,
      singleFlight: true,
      run: createGatedTick({
        isInputActive: inputActive,
        isVisible: () => paneGate.visible(),
        onHidden: () => {
          panePaused = true;
          if (resumePollEnabled()) startResumePoll();
        },
        onVisible: () => {
          stopResumePoll();
          panePaused = false;
        },
        isDbUnchanged: () => tracker !== null && !tracker.dbChanged(),
        action: () => doRefresh(false),
      }),
    });
  }

  // Event-driven DB-change watch (parent WL-0MV02VA29009WBEN): react to an
  // agent write within ~2 s instead of waiting for the 30 s refresh tick.
  // The watch feeds the EXISTING gated path — `requestWatchRefresh` applies
  // the typing + visibility gates and then calls `doRefresh`, which owns the
  // single-flight + trailing-coalescing guards (no bypass, no storm).
  // Fail-open: when the watch cannot start (`active === false`), the 30 s
  // tick remains the fallback and the zero-spawn-when-idle guarantee holds
  // because the tick is still gated by `isDbUnchanged`.
  const requestWatchRefresh = async (): Promise<void> => {
    if (inputActive()) return;
    if (!(await paneGate.visible())) return;
    // Consume the DB-change signal BEFORE refreshing, so the next periodic
    // tick sees the change as already handled and stays a no-op — the watch
    // must not leave the `DbChangeTracker` baseline stale (idle zero-spawn
    // guarantee, WL-0MSJ1OLTL009N4IQ). Do NOT consume when a gate above
    // skipped the work: an unconsumed change is what lets the fallback tick
    // (or the resume-poll) refresh once the overlay closes / the tab returns.
    tracker?.dbChanged();
    await doRefresh(false);
    // The state counter is bumped by `wl` BEFORE the write commits (pre-action
    // cache invalidation), so a watch event can fire while the DB write is
    // still landing. Re-check the counter AFTER the refresh: if it moved
    // again (the write settled mid-refresh), run one final trailing refresh
    // so the pane never shows a pre-commit snapshot until the next write or
    // the 30 s tick. Bounded by doRefresh's single-flight + trailing
    // coalescing — never a storm.
    if (tracker?.dbChanged()) {
      void doRefresh(false);
    }
  };

  let dbChangeWatch: DbChangeWatch | null = null;
  if (opts.autoRefresh && worklogDir) {
    try {
      dbChangeWatch = opts.dbWatch(
        resolveCacheDir(),
        worklogDir,
        () => {
          void requestWatchRefresh();
        },
        opts.dbWatchOptions,
      );
    } catch {
      // Fail-open: a watch construction failure must never break the pane.
      dbChangeWatch = null;
    }
  }

  // Auto-sync task (background wl sync) — the only auto-sync source. Uses
  // the single-flight + lock-aware (--if-idle) guard so concurrent
  // panes/TUI instances skip instead of piling up under lock contention,
  // and the cross-instance heartbeat (F3) so only the first pane per window
  // spawns `wl sync` at all. Visibility-gated like the refresh task: hidden
  // panes skip the sync (and its follow-up refresh) entirely. Typing-gated
  // (WL-0MTV67MZU003H7SH): ticks are skipped while any text-input overlay is
  // open — `isInputActive()` covers FormState, ShipItDialog, and md-note-edit
  // (via FormState). See resume contract on the refresh task above. Fires once
  // immediately on start (as the previous SyncTimer did) so the first sync
  // cycle is not delayed.
  if (opts.autoSync && opts.syncIntervalMs !== 0) {
    // Heartbeat window tied to the configured interval (interval minus a 15s
    // margin) so the sync cadence still lands ~once per interval while only
    // the first pane per window spawns a process.
    const heartbeatTtlMs = heartbeatTtlForInterval(opts.syncIntervalMs);
    scheduler.addTask({
      id: 'sync',
      intervalMs: opts.syncIntervalMs,
      fireImmediately: true,
      run: createGatedTick({
        isInputActive: inputActive,
        isVisible: () => paneGate.visible(),
        onHidden: () => {
          panePaused = true;
          if (resumePollEnabled()) startResumePoll();
        },
        onVisible: () => {
          stopResumePoll();
          panePaused = false;
        },
        // DB-change gate: skip when DB unchanged AND last sync fresh within cap.
        // Subject to existing heartbeat / single-flight / --if-idle guards in doSync.
        isDbUnchanged: () => {
          if (tracker && opts.maxSyncStalenessMs > 0) {
            const dbChanged = tracker.dbChanged();
            const syncDir = worklogDir ?? join(process.cwd(), '.worklog');
            const heartbeatFresh = isSyncHeartbeatFresh(syncDir, opts.maxSyncStalenessMs);
            if (!dbChanged && heartbeatFresh) return true;
          }
          return false;
        },
        action: () => {
          doSync(true, heartbeatTtlMs); // ifIdle + heartbeat: skip when another sync is in-flight / fresh
          doRefresh(false);
        },
      }),
    });
  }

  // Subscribe to background-sync status transitions so the header notice
  // appears the instant a sync spawns and clears the instant it settles —
  // both via asynchronous libuv events, never on the refresh path. The
  // subscription also adopts a sync already in flight in this process
  // (F3 — WL-0MVJV2O7H003HY9N).
  if (opts.autoSync) {
    unsubscribeSyncStatus = onSyncStatusChange(() => {
      refreshSyncNotice();
      if (getSyncStatus().inFlight) startSyncNoticeTicker();
      else stopSyncNoticeTicker();
      render();
    });
    refreshSyncNotice();
    if (getSyncStatus().inFlight) startSyncNoticeTicker();
  }

  // Visibility resume-poll — runs only while the pane's tab is hidden. Polls
  // tab visibility on a short interval so the hidden → visible transition
  // triggers an immediate doRefresh instead of waiting for the next
  // refreshIntervalMs tick. The poll uses only herdr tab get (via the
  // PollGate memoizer, TTL aligned with the poll interval) — never wl —
  // preserving the zero-wl-when-hidden guarantee.
  scheduler.addTask({
    id: 'resume-poll',
    intervalMs: DEFAULT_POLL_GATE_TTL_MS,
    singleFlight: true,
    disabled: true,
    run: async () => {
      if (await paneGate.visible()) {
        stopResumePoll();
        panePaused = false;
        // Hydrator focus-resume (AC4): the hidden→visible transition also
        // re-checks `in_progress` claims immediately — the same runner the
        // 30 s hydrate task uses — so a claim whose item pane was closed while
        // the pane was hidden is released as soon as focus returns (no wait
        // for the next hydrate tick). This runs BEFORE the DB-change gate
        // because opening/closing a work-item pane does not touch the worklog
        // DB (WL-0MV1BWETT005GSUJ). `paneGate.visible()` is already cached
        // true here, so the runner proceeds without a new visibility probe.
        void runHydrator();
        // Selection-list marker (WL-0MV1BWETT005GSUJ): re-evaluate pane
        // existence independently of the DB-change gate below — opening or
        // closing a work-item pane does not touch the worklog DB, so a
        // DB-gated refresh can never show/clear its marker.
        void refreshPaneMarkers();
        // DB-change gate: skip the refresh when the DB is unchanged (same as
        // the regular refresh tick).
        if (tracker && !tracker.dbChanged()) {
          return; // DB unchanged — no need to refresh on visibility change
        }
        doRefresh(true);
      }
    },
  });

  // Hydrator task — self-healing `in_progress` claims (WL-0MSOJLZD9004P8PI):
  // every 30 s it fetches `in_progress` items, matches each against the exact
  // item-ID tab labels of the current workspace (`herdr tab list`), and
  // demotes any item with no matching tab so the claim re-enters the
  // dispatchable pool. Visibility-gated via the runner
  // (AC5 — a hidden tab spawns zero wl/herdr processes); single-flight +
  // scheduler-level watchdog so a hung `wl`/`herdr` run is abandoned after
  // HYDRATOR_RUN_TIMEOUT_MS and retried on the next tick.
  scheduler.addTask({
    id: 'hydrate',
    intervalMs: HYDRATOR_INTERVAL_MS,
    singleFlight: true,
    runTimeoutMs: HYDRATOR_RUN_TIMEOUT_MS,
    run: async () => {
      await runHydrator();
    },
  });

  // Active-pane marker task (WL-0MV1BWETT005GSUJ): the selection-list marker
  // must reflect pane existence, but the regular refresh tick is DB-change
  // gated and opening/closing a work-item pane does NOT touch the worklog DB.
  // This task re-evaluates panes on the hydrator cadence and re-renders,
  // spawning only `herdr pane list` (never `wl`), so the zero-`wl`-when-idle
  // guarantee holds. Visibility- and typing-gated like the hydrator.
  if (opts.autoRefresh) {
    scheduler.addTask({
      id: 'active-pane-marker',
      intervalMs: HYDRATOR_INTERVAL_MS,
      singleFlight: true,
      runTimeoutMs: HYDRATOR_RUN_TIMEOUT_MS,
      run: async () => {
        if (inputActive()) return;
        if (!(await paneGate.visible())) return;
        await refreshPaneMarkers();
      },
    });
  }

  // Downtime-worker task — polls the llama-proxy for idle state and, after
  // the configured idle threshold, dispatches a pi agent pane (parent
  // WL-0MSF49FMW009M06K). Unlike refresh/sync it is NOT visibility-gated or
  // typing-gated (WL-0MTV67MZU003H7SH audit): the worker only probes the
  // proxy for idle state and, when idle long enough, dispatches a new pane
  // — it never triggers a worklist list refresh or re-render while the
  // typing overlay stays visible, so gating would only delay the (low
  // urgency) dispatch with no keypress-loss benefit.
  // Single-flight: the poller and dispatch guards inside the worker prevent
  // overlapping work; the scheduler task itself is also single-flight.
  // Scheduler-level watchdog (WL-0MSJIPHD0001L1J9): a tick run that hangs
  // (e.g. an unbounded wl invocation) is abandoned after
  // DOWNTIME_RUN_TIMEOUT_MS and the single-flight flag resets so the next
  // tick retries — a hung run can never permanently wedge the downtime
  // task until a pane restart.
  if (opts.downtimeWorker) {
    scheduler.addTask({
      id: 'downtime',
      intervalMs: opts.downtimePollIntervalMs,
      // Probe jitter (WL-0MSSRED76008LGB6): the effective poll interval is
      // jittered ±50% of the configured downtimePollIntervalMs per tick
      // (random, injectable via the registry's RNG) so instances with
      // identical configuration do not probe in lockstep — the jittered
      // interval is recomputed fresh on EVERY reschedule. Fallback: when
      // the worker's registry is unavailable, the static interval stands.
      getIntervalMs: opts.downtimeWorker
        ? () => opts.downtimeWorker!.jitterPollIntervalMs(opts.downtimePollIntervalMs)
        : undefined,
      singleFlight: true,
      runTimeoutMs: DOWNTIME_RUN_TIMEOUT_MS,
      run: async () => {
        await opts.downtimeWorker?.tick();
      },
    });
  }

  scheduler.start();

  // Cleanup on promise resolution
  promise.finally(() => {
    scheduler.stop();
    dbChangeWatch?.dispose();
    closeEventSubscriber();
    cleanup();
    process.stdout.removeListener('resize', onResize);
    process.stdin.removeListener('data', onData);
  });

  return promise;
}
