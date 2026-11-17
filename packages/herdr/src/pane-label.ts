/**
 * packages/herdr/src/pane-label.ts — canonical pane-label parsing
 * (WL-0MWHWH1HV009C46C)
 *
 * Map pointer: the single pane-creation architecture map + naming contract
 * (cross-referenced here) live in `docs/dev/downtime-dispatcher.md` → *Pane
 * creation architecture*.
 *
 * The single canonical module for pane-label parsing, mirroring
 * `pane-title.ts` as the single canonical module for pane-title
 * construction. Every consumer — the downtime dispatcher
 * (`downtime-worker.pane.ts`), the pane-closure reaper
 * (`pane-close-herdr.ts`), the host budget repair
 * (`host-dispatch-budget.repair.ts`), stalled-work, long-running-panes, the
 * hydrator and the ship guard — parses pane labels with these same
 * primitives, so a label-format change (e.g. the hydrator evidence fix,
 * WL-0MWH56SWX004HSKQ) touches ONE module instead of four.
 *
 * ## Settled conventions (AC2)
 *
 * The three pre-existing parsers diverged on two axes; both are settled here
 * authoritatively:
 *
 *  1. **Shape validation is authoritative.** The token after the last ` - `
 *     must match {@link WORK_ITEM_ID_SUFFIX_REGEX} — the deliberate safety
 *     net the reaper (`pane-close-herdr.ts::paneItemIdFromLabel`) applied and
 *     the former `downtime-worker.pane.ts::paneLabelItemId` skipped. Work-item
 *     IDs have a strict shape, so a canonical parser must never let a
 *     non-id token masquerade as a work-item id for ANY consumer: the
 *     dispatcher's equality matches are a no-op for valid IDs (a real ID
 *     always conforms) and simply refuse garbage; the classifiers
 *     (`stalled-work`, `long-running-panes`) and the budget repair fail
 *     closed on a non-conforming suffix instead of acting on a fake ID.
 *  2. **Absence returns `''`.** The former `paneLabelItemId` returned `null`;
 *     the divergent null-vs-'' pair masked the same fact ("no id"). The
 *     single canonical function returns the empty string, so every consumer
 *     tests one convention (`!== ''`).
 *
 * `extractWorkItemIdsFromText` is a deliberately DIFFERENT granularity (AC4):
 * it scans the whole text for every ID-shaped token (a title may carry more
 * than one ID), whereas {@link paneItemIdFromLabel} reads the single trailing
 * suffix token. The shared {@link WORK_ITEM_ID_REGEX} constant keeps the two
 * parses honest about their distinct shapes.
 */

/** Prefix of every downtime dispatched pane label (`buildDowntimePaneTitle`). */
export const DOWNTIME_PANE_LABEL_PREFIX = 'Downtime';

/**
 * Single-shape work-item-ID validator used by {@link paneItemIdFromLabel}.
 * Work-item IDs are single uppercase tokens like `WL-0ABC123` or
 * `CG-0XYZ`; anything else is not an ID. This is the authoritative shape
 * check the reaper historically applied as its safety net (see module docs).
 */
export const WORK_ITEM_ID_SUFFIX_REGEX = /^[A-Z]{2,}-[A-Z0-9]+$/;

/**
 * Extract-every-id matcher for {@link extractWorkItemIdsFromText} — the
 * different-granularity scan: every ID-shaped token anywhere in the text,
 * not just the trailing suffix. Stricter suffix length than
 * {@link WORK_ITEM_ID_SUFFIX_REGEX} (`{6,}`) because scanning arbitrary
 * text needs a tighter shape to avoid false positives on ordinary words.
 */
export const WORK_ITEM_ID_REGEX = /[A-Z][A-Z0-9]*-[0-9A-Z]{6,}/g;

/**
 * True when a label is a downtime dispatched pane label — it starts with
 * {@link DOWNTIME_PANE_LABEL_PREFIX} (`Downtime`).
 *
 * The canonical prefix predicate (AC3): every prefix-matching call site uses
 * this instead of a bare `label.startsWith(DOWNTIME_PANE_LABEL_PREFIX)`, so
 * a prefix-format change lands in this module alone.
 */
export function isDowntimePaneLabel(label: string | undefined): boolean {
  return typeof label === 'string' && label.startsWith(DOWNTIME_PANE_LABEL_PREFIX);
}

/** Every dispatch kind a pane label can name (launcher keywords). */
export const PANE_KINDS = ['implement', 'risk-effort', 'intake', 'audit', 'plan'] as const;

/** The kind derived from a pane label: one of {@link PANE_KINDS} or `unknown`. */
export type PaneLabelKind = (typeof PANE_KINDS)[number] | 'unknown';

/**
 * Derive the pane kind from its label. Scans for the skill keyword the
 * launcher embeds (`Downtime triggered <kind> …`, `Manually triggered
 * <kind> …`, or a bare `<skill> …`). Unknown labels classify as `unknown`
 * (fail-closed: the classifier never auto-closes `unknown` unless the marker
 * or dead-agent/idle rules apply — and those are still bounded by the
 * guards).
 *
 * Canonical home of the reaper's `paneKindFromLabel` (the loose substring
 * scan — NOT the stricter `<Downtime|Manually> triggered <kind>` contract
 * `stalled-work.ts::stalledPaneKindFromLabel` implements, which stays a
 * separate, deliberately stricter classifier).
 */
export function paneKindFromLabel(label: string | undefined): PaneLabelKind {
  const lower = (label ?? '').toLowerCase();
  for (const kind of PANE_KINDS) {
    if (lower.includes(kind)) return kind;
  }
  return 'unknown';
}

/**
 * Trailing work-item id in a pane label (`… - WL-XXXX`).
 *
 * `buildDowntimePaneTitle` preserves the item id as a SUFFIX
 * (`Downtime triggered <kind> <title> - <ITEM-ID>`, via
 * `truncatePaneTitlePreservingSuffix`), so the id is the token after the
 * last ` - `. A manually-named pane (`Downtime <kind>`) has no id → `''`.
 *
 * The returned token must match {@link WORK_ITEM_ID_SUFFIX_REGEX} — the
 * settled, validated convention (see module docs). Returns `''` when the
 * label is absent, has no ` - ` separator, has an empty/whitespace suffix,
 * or the suffix is not work-item-ID shaped.
 */
export function paneItemIdFromLabel(label: string | undefined): string {
  if (typeof label !== 'string' || label === '') return '';
  const idx = label.lastIndexOf(' - ');
  if (idx < 0) return '';
  const id = label.slice(idx + 3).trim();
  // Single shape: only a work-item-ID-shaped token is an id.
  return WORK_ITEM_ID_SUFFIX_REGEX.test(id) ? id : '';
}

/**
 * Extract every work-item ID appearing in `text` (e.g. a shell command line
 * or tab/window title). Always returns a fresh array; no shared regex state.
 *
 * DIFFERENT granularity than {@link paneItemIdFromLabel} (AC4): this scans
 * the full text for every ID-shaped token (any position, possibly several),
 * while the suffix parser reads the single trailing ID. Used by the hydrator
 * for active-pane-title matching and by the ship guard for blocking-pane
 * detection.
 */
export function extractWorkItemIdsFromText(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.match(WORK_ITEM_ID_REGEX) ?? [];
}
