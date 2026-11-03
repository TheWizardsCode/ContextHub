/**
 * packages/herdr/src/dispatcher-anchor.cli-parsers.ts — `herdr` CLI output
 * parsers for the dispatcher-anchor family.
 *
 * Single responsibility: decode raw `herdr` JSON envelopes and
 * `/proc/<pid>/environ` blobs into the typed results declared in
 * `dispatcher-anchor.contract.ts` — `parseTabListOutput`,
 * `parseTabCreateOutput`, `parsePaneListOutput`,
 * `parseMachinePaneListOutput`, `parsePaneProcessInfoOutput` and
 * `parseProcEnviron`.
 *
 * Moved verbatim out of `dispatcher-anchor.ts` (parent WL-0MVGKHCP9005SJPZ;
 * child WL-0MW0JH9QP00131ZJ). No behaviour change: the same signatures, the
 * same tolerated output shapes and the same fail-closed `null` semantics.
 *
 * Layering: every function here is pure and imports TYPES ONLY from
 * `dispatcher-anchor.contract.js` (the split's leaf module) — never the
 * `dispatcher-anchor.js` barrel, so this module cannot take part in a runtime
 * import cycle. The barrel re-exports all six unchanged.
 */

import type {
  DispatcherPaneInfo,
  DispatcherTabInfo,
  ItemTabAnchor,
  MachinePaneInfo,
  PaneProcessInfo,
} from './dispatcher-anchor.contract.js';

// ── herdr tab/pane CLI output parsers ──────────────────────────────────

/**
 * Parse `herdr tab list` JSON output into `{ tabId, label, agentStatus? }`
 * records (the agent status is carried for liveness-aware consumers such as
 * the hydrator's running-pane check).
 *
 * Tolerates log lines before the JSON envelope (scan for the first `{`), the
 * `{ result: { tabs: [...] } }` envelope, a bare `{ tabs: [...] }` shape, and
 * the `tab_id` / `tabId` / `id` key variants plus `label` / `title` and
 * `agent_status` / `agentStatus`.
 * Returns `null` when no tab array can be found (caller fails closed — never
 * treat an unparseable list as "no tab exists", which would duplicate tabs).
 */
export function parseTabListOutput(raw: string): DispatcherTabInfo[] | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const tabs = Array.isArray(result.tabs) ? result.tabs : Array.isArray(obj.tabs) ? obj.tabs : null;
  if (tabs === null) return null;

  const out: DispatcherTabInfo[] = [];
  for (const entry of tabs) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const tabId = rec.tab_id ?? rec.tabId ?? rec.id;
    const label = rec.label ?? rec.title;
    if (typeof tabId === 'string' && tabId !== '' && typeof label === 'string') {
      const rawAgentStatus = rec.agent_status ?? rec.agentStatus;
      const agentStatus = typeof rawAgentStatus === 'string' ? rawAgentStatus : undefined;
      out.push(agentStatus !== undefined ? { tabId, label, agentStatus } : { tabId, label });
    }
  }
  return out;
}

/**
 * Parse `herdr tab create` JSON output for the new tab id and its root
 * (anchor) pane id.
 *
 * Live herdr 0.7.5 shape:
 * `{ result: { tab: { tab_id, label, … }, root_pane: { pane_id, tab_id, … } } }`.
 * Tolerates the `tab_id` / `tabId` / `id` and `pane_id` / `paneId` / `id` key
 * variants plus a flat (non-nested) result. Returns `null` on any parse
 * failure so a caller can abort before persisting a bogus anchor.
 */
export function parseTabCreateOutput(raw: string): ItemTabAnchor | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const tab = (result.tab ?? {}) as Record<string, unknown>;
  const rootPane = (result.root_pane ?? result.rootPane ?? {}) as Record<string, unknown>;
  const tabId = tab.tab_id ?? tab.tabId ?? tab.id ?? result.tab_id ?? result.tabId;
  const paneId =
    rootPane.pane_id ?? rootPane.paneId ?? rootPane.id ?? result.pane_id ?? result.paneId;
  if (typeof tabId !== 'string' || tabId === '' || typeof paneId !== 'string' || paneId === '') {
    return null;
  }
  return { tabId, paneId };
}

/** Parse `herdr pane list` records down to `{ paneId, tabId }` (tab routing). */
export function parsePaneListOutput(raw: string): DispatcherPaneInfo[] | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const panes = Array.isArray(result.panes) ? result.panes : Array.isArray(obj.panes) ? obj.panes : null;
  if (panes === null) return null;

  const out: DispatcherPaneInfo[] = [];
  for (const entry of panes) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const paneId = rec.pane_id ?? rec.paneId;
    const tabId = rec.tab_id ?? rec.tabId;
    if (typeof paneId === 'string' && paneId !== '' && typeof tabId === 'string' && tabId !== '') {
      out.push({ paneId, tabId });
    }
  }
  return out;
}

/**
 * Parse machine-wide `herdr pane list` JSON into records used for
 * project-workspace resolution.
 *
 * Tolerates log lines before the JSON envelope, the
 * `{ result: { panes: [...] } }` envelope and the bare-array shape, plus
 * `pane_id`/`paneId`, `workspace_id`/`workspaceId`, `tab_id`/`tabId`.
 * `label`/`title` supply the plugin-pane label and `focused`/`is_focused` the
 * ambiguity signal. Returns `null` when no pane array can be found (caller
 * fails closed).
 */
export function parseMachinePaneListOutput(raw: string): MachinePaneInfo[] | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const panes = Array.isArray(result.panes) ? result.panes : Array.isArray(obj.panes) ? obj.panes : null;
  if (panes === null) return null;

  const out: MachinePaneInfo[] = [];
  for (const entry of panes) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const paneId = rec.pane_id ?? rec.paneId;
    const workspaceId = rec.workspace_id ?? rec.workspaceId;
    const tabId = rec.tab_id ?? rec.tabId;
    if (typeof paneId !== 'string' || paneId === '') continue;
    if (typeof workspaceId !== 'string' || workspaceId === '') continue;
    if (typeof tabId !== 'string' || tabId === '') continue;
    const label =
      typeof rec.label === 'string'
        ? rec.label
        : typeof rec.title === 'string'
          ? rec.title
          : undefined;
    const focused =
      rec.focused === true || rec.is_focused === true || rec.isFocused === true;
    out.push({ paneId, workspaceId, tabId, ...(label !== undefined ? { label } : {}), focused });
  }
  return out;
}

/**
 * Parse `herdr pane process-info` JSON for the pane's shell pid.
 *
 * Tolerates log lines, the `{ result: { process_info: { shell_pid } } }`
 * envelope and the `shell_pid`/`shellPid` key variants. Returns `null` on any
 * parse failure or a missing/empty pid (caller fails closed).
 */
export function parsePaneProcessInfoOutput(raw: string): PaneProcessInfo | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const info =
    result.process_info !== null && typeof result.process_info === 'object'
      ? (result.process_info as Record<string, unknown>)
      : result.processInfo !== null && typeof result.processInfo === 'object'
        ? (result.processInfo as Record<string, unknown>)
        : result;
  const shellPid = info.shell_pid ?? info.shellPid;
  if (typeof shellPid !== 'string' && typeof shellPid !== 'number') return null;
  const asString = String(shellPid);
  if (asString === '') return null;
  return { shellPid: asString };
}

/**
 * Parse a null-delimited `/proc/<pid>/environ` blob into a variable map.
 * Splits on NUL (tolerating a trailing newline), keeping the LAST value of a
 * duplicated key (process env is last-wins). Malformed entries without `=`
 * are skipped; values may legitimately contain `=`.
 */
export function parseProcEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    if (entry === '') continue;
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    env[entry.slice(0, idx).trim()] = entry.slice(idx + 1).replace(/\n$/, '');
  }
  return env;
}
