/**
 * packages/herdr/src/downtime-worker.parsers.ts — `wl` stdout parsers for the
 * downtime worker.
 *
 * Single responsibility: turn raw `wl` CLI stdout into typed downtime-worker
 * candidates/items, plus the critical-tier stage→skill mapping. Every parser
 * is pure and fail-closed (malformed or absent output → `null`, never a
 * throw); none of them applies selection policy — that lives in
 * `downtime-worker.selection.ts`.
 *
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * child WL-0MVLIHYOU000YQ0R). No behaviour change: parser tolerance, accepted
 * output shapes and null/empty semantics are unchanged.
 *
 * Layering: this module imports TYPES ONLY, and never the barrel
 * (`downtime-worker.js`) nor `./stalled-work.js` (which imports values back
 * from the barrel), so the pre-existing type-only cycle cannot widen into a
 * runtime cycle.
 */

import type {
  AuditCandidate,
  DowntimeCandidate,
  DowntimeItemInfo,
  DowntimeSkillKind,
  DowntimeStage,
  ImplementCandidate,
} from './downtime-worker.types.js';

// ── Wiring helpers (implemented — F4) ─────────────────────────────────

/**
 * Parse the stdout of `wl next --stage <stage> -n N --json` into typed
 * plan/intake candidates. Accepts both the batch shape the CLI emits for
 * `-n N` (`{ workItems: [{ workItem: {...} }] }`) and the legacy single-item
 * shape (`{ workItem: {...} }`) for backward compatibility. Each candidate
 * carries the query `stage`, the worklog `status` (for the client-side
 * `open` guard) and `sortIndex` (wl next priority order). Malformed JSON or
 * output without any parseable entry yields null (fail-closed); an empty
 * result list yields `[]` (a genuine empty backlog).
 */
export function parseNextCandidatesOutput(
  stdout: string,
  stage: DowntimeStage,
): DowntimeCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  let rawItems: unknown[] | null = null;
  if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.workItems)) {
      rawItems = o.workItems;
    } else if (typeof o.workItem === 'object' && o.workItem !== null) {
      rawItems = [o]; // legacy single-item shape with a candidate
    } else if ('workItem' in o) {
      rawItems = []; // legacy single-item shape answered no item → empty backlog
    }
  }
  if (rawItems === null) return null;

  const candidates: DowntimeCandidate[] = [];
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue;
    const nested =
      (entry as { workItem?: unknown }).workItem !== undefined
        ? (entry as { workItem: Record<string, unknown> }).workItem
        : (entry as Record<string, unknown>);
    if (typeof nested !== 'object' || nested === null) continue;
    if (typeof nested.id !== 'string' || nested.id.length === 0) continue;
    candidates.push({
      id: nested.id,
      title: typeof nested.title === 'string' ? nested.title : '',
      stage,
      status: typeof nested.status === 'string' ? nested.status : undefined,
      sortIndex:
        typeof nested.sortIndex === 'number' && Number.isFinite(nested.sortIndex)
          ? nested.sortIndex
          : undefined,
      priority: typeof nested.priority === 'string' ? nested.priority : undefined,
      deletedBy: typeof nested.deletedBy === 'string' ? nested.deletedBy : undefined,
      assignee: typeof nested.assignee === 'string' ? nested.assignee : undefined,
      needsProducerReview:
        nested.needsProducerReview !== undefined ? Boolean(nested.needsProducerReview) : undefined,
    });
  }
  return candidates;
}

/**
 * Parse the stdout of `wl next --stage <stage> --json` into the first
 * candidate. Returns null (no dispatch) for empty output, a null
 * `workItem`, missing ids, or malformed JSON.
 *
 * Superseded by `parseNextCandidatesOutput` for production selection (the
 * downtime worker fetches a batch so marker-excluded candidates do not
 * starve selection); kept exported for callers/tests that use the
 * single-item shape.
 */
export function parseNextItemOutput(stdout: string, stage: DowntimeStage): DowntimeCandidate | null {
  try {
    const parsed = JSON.parse(stdout) as {
      workItem?: { id?: unknown; title?: unknown } | null;
    };
    const raw = parsed?.workItem;
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
    return {
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : '',
      stage,
    };
  } catch {
    return null;
  }
}

/**
 * Derive the dispatch kind from a prompt built by `buildDowntimePrompt`
 * (the pane name is `Downtime plan` / `Downtime intake` / `Downtime audit`
 * / `Downtime implement` / `Downtime risk-effort`).
 */
export function skillKindFromPrompt(prompt: string): DowntimeSkillKind {
  if (prompt.includes('/skill:audit ')) return 'audit';
  if (prompt.includes('/skill:implement ')) return 'implement';
  if (prompt.includes('/skill:effort-and-risk ')) return 'risk-effort';
  return prompt.includes('/skill:plan ') ? 'plan' : 'intake';
}

// ── Audit-tier parsing (WL-0MSI8H3HP000K0RG) ──────────────────────────
// (parsing half of the former "Audit-tier selection" section; the
// selector itself lives in downtime-worker.selection.ts)

/**
 * Parse the stdout of `wl list --status completed --stage in_review
 * --root-only --json` (root-only, WL-0MSTLFW14000KPEC: only parent items
 * are audit candidates) into typed audit candidates. Accepts both the bare
 * array shape and the `{ workItems: [...] }` wrapper. Malformed/empty
 * output yields null (fail-closed).
 */
export function parseAuditCandidatesOutput(stdout: string): AuditCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const candidates: AuditCandidate[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    candidates.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      auditedAt: typeof o.auditedAt === 'string' ? o.auditedAt : undefined,
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined,
      fingerprint: typeof o.fingerprint === 'string' ? o.fingerprint : undefined,
      currentFingerprint: typeof o.currentFingerprint === 'string' ? o.currentFingerprint : undefined,
      sortIndex: typeof o.sortIndex === 'number' && Number.isFinite(o.sortIndex) ? o.sortIndex : undefined,
      priority: typeof o.priority === 'string' ? o.priority : undefined,
      parentId: o.parentId == null ? (o.parentId as null | undefined) : String(o.parentId),
      deletedBy: typeof o.deletedBy === 'string' ? o.deletedBy : undefined,
      needsProducerReview:
        o.needsProducerReview !== undefined ? Boolean(o.needsProducerReview) : undefined,
      assignee: typeof o.assignee === 'string' ? o.assignee : undefined,
    });
  }
  return candidates;
}

/**
 * Parse the item ids from `wl list --status in_progress --json` output
 * (WL-0MT3PHW4I002SNOV): returns the ids of every item currently
 * `in_progress`, or null on malformed output (fail-closed — the
 * active-audit single-flight check treats an unparseable worklog query as
 * a failed check, `{ok:false}`). Accepts the same shapes as the other wl
 * parsers: a `{workItems: [...]}` object with bare item objects, a
 * `{workItems: [{workItem: {...}}]}` wrapper shape, or a bare array.
 * Entries without a usable id are skipped.
 */
export function parseInProgressOutput(stdout: string): Set<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const ids = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    // Accept both bare item objects and the {workItem: {...}} wrapper.
    const wrapped = typeof o.workItem === 'object' && o.workItem !== null
      ? (o.workItem as Record<string, unknown>)
      : undefined;
    const id = typeof wrapped?.id === 'string'
      ? wrapped.id
      : typeof o.id === 'string'
        ? o.id
        : undefined;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids;
}

// ── Implement-tier candidate parsing (WL-0MSMAYPQP001FLR6) ───────────
// (parsing half of the former "Implement-tier selection" section; the
// selector and its risk/effort ordinals live in
// downtime-worker.selection.ts)

/**
 * Parse the stdout of `wl next --stage plan_complete --risk low --effort
 * small -n N --json` into typed implement candidates. Accepts the
 * `{ workItems: [{ workItem: {...} }] }` shape the CLI emits for a batch
 * (`-n N`); entries without an id are skipped. Malformed JSON or output
 * without a workItems list yields null (fail-closed); an empty list yields
 * `[]` (a genuine empty backlog).
 */
export function parseImplementCandidatesOutput(stdout: string): ImplementCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const candidates: ImplementCandidate[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { workItem?: Record<string, unknown> };
    const o = entry.workItem;
    if (typeof o !== 'object' || o === null) continue;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    candidates.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      status: typeof o.status === 'string' ? o.status : '',
      risk: typeof o.risk === 'string' ? o.risk : undefined,
      effort: typeof o.effort === 'string' ? o.effort : undefined,
      sortIndex: typeof o.sortIndex === 'number' && Number.isFinite(o.sortIndex) ? o.sortIndex : undefined,
      priority: typeof o.priority === 'string' ? o.priority : undefined,
      deletedBy: typeof o.deletedBy === 'string' ? o.deletedBy : undefined,
      assignee: typeof o.assignee === 'string' ? o.assignee : undefined,
      needsProducerReview:
        o.needsProducerReview !== undefined ? Boolean(o.needsProducerReview) : undefined,
    });
  }
  return candidates;
}

// ── Critical-first candidate parsing (WL-0MT3FM8VA005XBHE, F2) ───────
// (parsing half of the former "Critical-first selection" section; the
// tier explanation, selector and frontier walk live in
// downtime-worker.selection.ts)

/**
 * An open critical work-item candidate, enumerated by
 * `wl list --priority critical --status open` (blocked items included —
 * `wl list` does not exclude dependency-blocked items). Carries the
 * worklog `stage` (needed for the stage→skill mapping), the client-side
 * `status` guard, and the risk/effort fields for the plan_complete caps
 * (decision Q2).
 */
export interface CriticalCandidate {
  id: string;
  title: string;
  /** Worklog status (`open` for selectable items; fail-closed on missing). */
  status: string;
  /** Worklog stage: idea | intake_complete | plan_complete | in_progress | … */
  stage: string;
  risk?: string;
  effort?: string;
  /** wl priority order preserved for deterministic selection. */
  sortIndex?: number;
  /** Worklog priority level (critical) — round-robin grouping key. */
  priority?: string;
  /** Soft-delete attribution (SA-0MUJBLZC60085DI9): non-empty ⇒ excluded from selection. */
  deletedBy?: string;
  /** Assignee hold (WL-0MV85WCJJ0087VMP): non-empty ⇒ excluded from selection. */
  assignee?: string;
  /**
   * Needs producer review flag (parent WL-0MTIAL65N004T22F): when `true`,
   * exclude from critical-tier selection and from dependency-frontier
   * resolution (AC1, AC2).
   */
  needsProducerReview?: boolean;
}

/**
 * Map a critical candidate's worklog stage to the dispatch skill kind.
 * Only dispatchable stages map: `idea` → `intake`, `intake_complete` →
 * `plan`, `plan_complete` → `implement`. Every other stage (in_progress,
 * in_review, completed, …) is NOT a critical-tier dispatch target and
 * maps to null (the tier falls through to the normal order).
 */
export function criticalSkillKind(stage: string): DowntimeSkillKind | null {
  if (stage === 'idea') return 'intake';
  if (stage === 'intake_complete') return 'plan';
  if (stage === 'plan_complete') return 'implement';
  return null;
}

/**
 * Parse the stdout of `wl list --priority critical --status open --json`
 * into typed critical candidates. Accepts the shape the CLI emits for a
 * batch (`{ workItems: [...] }`, flat entries carrying the enriched
 * workItem fields). Entries without an id are skipped; malformed JSON or
 * output without a workItems list yields null (fail-closed); an empty
 * list yields `[]` (a genuine empty critical tier).
 */
export function parseCriticalCandidatesOutput(stdout: string): CriticalCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const candidates: CriticalCandidate[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    candidates.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      status: typeof o.status === 'string' ? o.status : '',
      stage: typeof o.stage === 'string' ? o.stage : '',
      risk: typeof o.risk === 'string' ? o.risk : undefined,
      effort: typeof o.effort === 'string' ? o.effort : undefined,
      sortIndex: typeof o.sortIndex === 'number' && Number.isFinite(o.sortIndex) ? o.sortIndex : undefined,
      priority: typeof o.priority === 'string' ? o.priority : undefined,
      deletedBy: typeof o.deletedBy === 'string' ? o.deletedBy : undefined,
      assignee: typeof o.assignee === 'string' ? o.assignee : undefined,
      needsProducerReview:
        o.needsProducerReview !== undefined ? Boolean(o.needsProducerReview) : undefined,
    });
  }
  return candidates;
}

/**
 * Parse the stdout of `wl dep list <id> --json` into the blocker refs of
 * the queried item: the outbound edges with direction `depends-on` (items
 * the queried item depends on — its blockers). Edge entries carry only
 * id/title/status/priority; the caller enriches via `wl show` when the
 * full stage/risk/effort/sortIndex fields are needed (frontier caps
 * check, Q2). Malformed JSON or output without an outbound edge list
 * yields null (fail-closed); an item with no outbound depends-on edges
 * yields `[]` (unblocked).
 */
export function parseDepListBlockersOutput(
  stdout: string,
): Array<{ id: string; title: string; status: string; priority?: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const outbound =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { outbound?: unknown }).outbound)
      ? (parsed as { outbound: unknown[] }).outbound
      : null;
  if (outbound === null) return null;

  const blockers: Array<{ id: string; title: string; status: string; priority?: string }> = [];
  for (const raw of outbound as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    // Only dependency edges count as blockers (the item depends on them
    // and is therefore blocked by them).
    if (o.direction !== 'depends-on') continue;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    blockers.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      status: typeof o.status === 'string' ? o.status : '',
      priority: typeof o.priority === 'string' ? o.priority : undefined,
    });
  }
  return blockers;
}

/**
 * Parse the stdout of `wl show <id> --json` into a full critical
 * candidate (the shape the frontier resolution needs for its
 * stage→skill mapping and implement caps checks). Accepts the CLI's
 * single-item shape `{ workItem: {...} }` with the enriched fields.
 * Malformed output or a missing workItem yields null (fail-closed).
 */
export function parseShownWorkItem(stdout: string): CriticalCandidate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const raw =
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { workItem?: unknown }).workItem !== null &&
    (parsed as { workItem?: unknown }).workItem !== undefined
      ? (parsed as { workItem: Record<string, unknown> }).workItem
      : null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    stage: typeof raw.stage === 'string' ? raw.stage : '',
    risk: typeof raw.risk === 'string' ? raw.risk : undefined,
    effort: typeof raw.effort === 'string' ? raw.effort : undefined,
    sortIndex: typeof raw.sortIndex === 'number' && Number.isFinite(raw.sortIndex) ? raw.sortIndex : undefined,
    priority: typeof raw.priority === 'string' ? raw.priority : undefined,
    needsProducerReview:
      raw.needsProducerReview !== undefined ? Boolean(raw.needsProducerReview) : undefined,
  };
}

/**
 * Parse the stdout of `wl show <id> --json` into a coordination item view
 * (`DowntimeItemInfo` — the leader's per-entry classification input).
 * Accepts the same `{ workItem: {...} }` single-item shape as
 * `parseShownWorkItem`, additionally capturing `updatedAt` and (when the
 * CLI serves it) `auditedAt` for the audit-tier freshness check. Malformed
 * output or a missing id yields null (fail-closed).
 */
export function parseShowItemOutput(stdout: string): DowntimeItemInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const raw =
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { workItem?: unknown }).workItem !== null &&
    (parsed as { workItem?: unknown }).workItem !== undefined
      ? (parsed as { workItem: Record<string, unknown> }).workItem
      : null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  const info: DowntimeItemInfo = {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    stage: typeof raw.stage === 'string' ? raw.stage : undefined,
    priority: typeof raw.priority === 'string' ? raw.priority : undefined,
    risk: typeof raw.risk === 'string' ? raw.risk : undefined,
    effort: typeof raw.effort === 'string' ? raw.effort : undefined,
    assignee: typeof raw.assignee === 'string' ? raw.assignee : undefined,
    auditedAt:
      typeof raw.auditedAt === 'string'
        ? raw.auditedAt
        : raw.auditedAt === null
          ? null
          : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    sortIndex: typeof raw.sortIndex === 'number' && Number.isFinite(raw.sortIndex) ? raw.sortIndex : undefined,
    deletedBy: typeof raw.deletedBy === 'string' ? raw.deletedBy : undefined,
    needsProducerReview:
      raw.needsProducerReview !== undefined ? Boolean(raw.needsProducerReview) : undefined,
  };
  // Top-level audit result (WL-0MU308WSF0002JWN): `wl show --json` serves
  // `auditResult` as a TOP-LEVEL sibling of `workItem` (not nested inside
  // it), carrying the audit verdict (`readyToClose`) the pane-lifecycle
  // monitor needs to distinguish audit-passed from audit-failed. Additive
  // and tolerant — a missing/malformed auditResult leaves the fields absent.
  const topAudit = (parsed as { auditResult?: unknown }).auditResult;
  if (topAudit !== null && typeof topAudit === 'object') {
    const a = topAudit as Record<string, unknown>;
    if (typeof a.auditedAt === 'string') info.auditedAt = a.auditedAt;
    if (typeof a.readyToClose === 'boolean') info.auditResult = a.readyToClose;
  }
  return info;
}
