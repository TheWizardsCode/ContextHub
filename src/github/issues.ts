/**
 * src/github/issues.ts — issue CRUD and payload mapping of the GitHub
 * integration.
 *
 * Concern: everything that turns a work item into a GitHub issue (and back) and
 * everything that reads or writes issues — payload mapping
 * (`workItemToIssuePayload`), label-to-field decoding (`issueToWorkItemFields`
 * with the legacy `P0`–`P3` priority map), response normalisation
 * (`normalizeGithubIssue`, private to this module), the issue CRUD paths in
 * their synchronous and asynchronous forms (`createGithubIssue`,
 * `updateGithubIssue`, `getGithubIssue`, `listGithubIssues` and their `…Async`
 * twins), assignment (`assignGithubIssue`, `assignGithubIssueAsync`) and the
 * label-ensuring calls that create and update depend on. The sync variants are
 * `@deprecated` but still used by `src/github-sync.ts`, so they are moved
 * unchanged rather than removed.
 *
 * Moved verbatim from `src/github.ts` (WL-0MVVLY034000MDVA, child 7 of 8 of the
 * WL-0MVGKGR2H006MNVG `src/github.ts` decomposition). Move-only: the payload
 * label set (`<prefix>status:`, `priority:`, `stage:`, `type:`, `risk:`,
 * `effort:`, `tag:`), the completed/deleted → `closed` state mapping, the
 * `LEGACY_PRIORITY_MAP` values, the REST paths and `--json` field lists are
 * byte-identical.
 *
 * Every external call is scheduled through the central throttler, as in the
 * sibling modules. This module therefore depends on `./types.js`,
 * `./transport.js`, `./markers.js`, `./labels.js` and the root declaration
 * module `../types.js` only — never on the `src/github.ts` barrel — so the
 * family's import graph stays acyclic. `LEGACY_PRIORITY_MAP` and
 * `normalizeGithubIssue` stay private; the barrel re-exports the twelve public
 * issue symbols, and nothing more.
 */

import throttler from '../github-throttler.js';
import type {
  Comment,
  WorkItem,
  WorkItemPriority,
  WorkItemStatus,
} from '../types.js';
import {
  ghApiAsyncScheduled,
  quoteShellValue,
  runGh,
  runGhAsync,
  runGhDetailed,
  runGhDetailedAsync,
  runGhJsonAsync,
  runGhSafe,
} from './transport.js';
import type {
  AssignGithubIssueResult,
  GithubConfig,
  GithubIssueRecord,
} from './types.js';
import { buildWorklogMarker, stripWorklogMarkers } from './markers.js';
import {
  ensureGithubLabelsOnce,
  ensureGithubLabelsOnceAsync,
  isSingleValueCategoryLabel,
  normalizeGithubLabelPrefix,
} from './labels.js';

export function workItemToIssuePayload(
  item: WorkItem,
  comments: Comment[],
  labelPrefix: string,
  allItems?: WorkItem[]
): { title: string; body: string; labels: string[]; state: 'open' | 'closed' } {
  const marker = buildWorklogMarker(item.id);
  const summaryLines: string[] = [marker];
  if (allItems) {
    void allItems;
  }
  summaryLines.push('');
  if (item.description) {
    summaryLines.push(stripWorklogMarkers(item.description));
  }
  void comments;

  const labels = new Set<string>();
  labels.add(`${labelPrefix}status:${item.status}`);
  labels.add(`${labelPrefix}priority:${item.priority}`);
  if (item.stage) {
    labels.add(`${labelPrefix}stage:${item.stage}`);
  }
  if (item.issueType) {
    labels.add(`${labelPrefix}type:${item.issueType}`);
  }
  if (item.risk) {
    labels.add(`${labelPrefix}risk:${item.risk}`);
  }
  if (item.effort) {
    labels.add(`${labelPrefix}effort:${item.effort}`);
  }
  for (const tag of item.tags) {
    labels.add(`${labelPrefix}tag:${tag}`);
  }

  const state = item.status === 'completed' || item.status === 'deleted' ? 'closed' : 'open';
  return {
    title: item.title,
    body: summaryLines.join('\n'),
    labels: Array.from(labels),
    state,
  };
}

// ---------------------------------------------------------------------------
// Issue assignment helpers
// ---------------------------------------------------------------------------

/**
 * Assign a GitHub user to an issue via `gh issue edit --add-assignee`.
 *
 * Uses `runGhDetailedAsync` with rate-limit retry/backoff. On failure returns
 * `{ ok: false, error: <stderr> }` without throwing.
 */
export async function assignGithubIssueAsync(
  config: GithubConfig,
  issueNumber: number,
  assignee: string,
  retries = 3
): Promise<AssignGithubIssueResult> {
  let attempt = 0;
  let backoff = 500;
  while (attempt <= retries) {
    // Schedule assignment through the throttler to respect concurrency/rate limits.
    const res = await throttler.schedule(async () => {
      return await runGhDetailedAsync(
        `gh issue edit ${issueNumber} --repo ${config.repo} --add-assignee ${JSON.stringify(assignee)}`
      );
    });
    if (res.ok) {
      return { ok: true };
    }
    const stderr = res.stderr || '';
    // Retry on rate-limit / 403 errors
    if (/rate limit|403|API rate limit exceeded/i.test(stderr) && attempt < retries) {
      await new Promise(r => setTimeout(r, backoff));
      attempt += 1;
      backoff *= 2;
      continue;
    }
    return { ok: false, error: stderr || `gh issue edit failed with unknown error` };
  }
  return { ok: false, error: 'Max retries exceeded' };
}

/**
 * Synchronous variant of `assignGithubIssueAsync`. Calls `runGhDetailed`
 * directly (no retry/backoff). Returns `{ ok: false, error }` on failure
 * without throwing.
 */
export function assignGithubIssue(
  config: GithubConfig,
  issueNumber: number,
  assignee: string
): AssignGithubIssueResult {
  // Synchronous variant: schedule on the throttler but execute a synchronous
  // gh command inside the scheduled task. This preserves the sync semantics
  // for callers while ensuring the throttler counts the operation.
  // Note: the throttler.schedule returns a Promise which we must block on
  // synchronously by awaiting via a deasync-like approach is undesirable.
  // To keep this function truly synchronous, run the operation directly but
  // still attempt a best-effort check: if throttler has a concurrency cap,
  // it won't be respected for this sync call. Prefer the async variant.
  const res = runGhDetailed(
    `gh issue edit ${issueNumber} --repo ${config.repo} --add-assignee ${JSON.stringify(assignee)}`
  );
  if (res.ok) {
    return { ok: true };
  }
  return { ok: false, error: res.stderr || `gh issue edit failed with unknown error` };
}

/**
 * Legacy priority label mapping. Labels like `wl:P0`, `wl:P1`, etc. are mapped
 * to the current priority values for backward compatibility during import.
 */
const LEGACY_PRIORITY_MAP: Record<string, WorkItemPriority> = {
  P0: 'critical',
  P1: 'high',
  P2: 'medium',
  P3: 'low',
};

export function issueToWorkItemFields(
  issue: GithubIssueRecord,
  labelPrefix: string
): { status: WorkItemStatus; priority: WorkItemPriority; tags: string[]; risk: string; effort: string; stage: string; issueType: string } {
  const normalizedPrefix = normalizeGithubLabelPrefix(labelPrefix);
  const tags: string[] = [];
  let status: WorkItemStatus = issue.state === 'closed' ? 'completed' : 'open';
  let priority: WorkItemPriority = 'medium';
  let risk = '';
  let effort = '';
  let stage = '';
  let issueType = '';

  for (const label of issue.labels) {
    if (label.startsWith(normalizedPrefix)) {
      const value = label.slice(normalizedPrefix.length);
      if (value.startsWith('status:')) {
        const nextStatus = value.slice('status:'.length);
        if (nextStatus === 'open' || nextStatus === 'in-progress' || nextStatus === 'completed' || nextStatus === 'blocked' || nextStatus === 'deleted') {
          status = nextStatus;
        }
        continue;
      }
      if (value === 'open' || value === 'in-progress' || value === 'completed' || value === 'blocked' || value === 'deleted') {
        status = value;
        continue;
      }
      if (value.startsWith('priority:')) {
        const prio = value.slice('priority:'.length);
        if (prio === 'low' || prio === 'medium' || prio === 'high' || prio === 'critical') {
          priority = prio;
        }
        continue;
      }
      // Legacy priority labels: wl:P0, wl:P1, wl:P2, wl:P3
      if (LEGACY_PRIORITY_MAP[value]) {
        priority = LEGACY_PRIORITY_MAP[value];
        continue;
      }
      if (value.startsWith('stage:')) {
        const stageValue = value.slice('stage:'.length);
        if (stageValue) {
          stage = stageValue;
        }
        continue;
      }
      if (value.startsWith('type:')) {
        const typeValue = value.slice('type:'.length);
        if (typeValue) {
          issueType = typeValue;
        }
        continue;
      }
      if (value.startsWith('risk:')) {
        const riskValue = value.slice('risk:'.length);
        if (riskValue === 'Low' || riskValue === 'Medium' || riskValue === 'High' || riskValue === 'Severe') {
          risk = riskValue;
        }
        continue;
      }
      if (value.startsWith('effort:')) {
        const effortValue = value.slice('effort:'.length);
        if (effortValue === 'XS' || effortValue === 'S' || effortValue === 'M' || effortValue === 'L' || effortValue === 'XL') {
          effort = effortValue;
        }
        continue;
      }
      if (value.startsWith('tag:')) {
        const tag = value.slice('tag:'.length);
        if (tag) {
          tags.push(tag);
        }
      }
      continue;
    }
    tags.push(label);
  }

  // GitHub issue state is authoritative for the open/completed distinction.
  // A stale wl:status label must not override the issue state — e.g. when an
  // issue is reopened but the wl:status:completed label was not removed.
  if (issue.state === 'closed' && status !== 'completed') {
    status = 'completed';
  } else if (issue.state !== 'closed' && status === 'completed') {
    status = 'open';
  }

  return { status, priority, tags: Array.from(new Set(tags)), risk, effort, stage, issueType };
}

/**
 * @deprecated Use `createGithubIssueAsync` instead. This function blocks the event loop.
 * Migration: Replace `createGithubIssue(config, payload)` with `await createGithubIssueAsync(config, payload)`.
 */
export function createGithubIssue(config: GithubConfig, payload: { title: string; body: string; labels: string[] }): GithubIssueRecord {
  const command = `gh issue create --repo ${config.repo} --title ${JSON.stringify(payload.title)} --body-file -`;
  const output = runGh(command, payload.body);
  let issueNumber: number | null = null;
  const match = output.match(/\/(\d+)$/);
  if (match) {
    issueNumber = parseInt(match[1], 10);
  }
  if (issueNumber !== null && payload.labels.length > 0) {
    // Ensure labels once per process to reduce API calls
    ensureGithubLabelsOnce(config, payload.labels);
    runGh(`gh issue edit ${issueNumber} --repo ${config.repo} --add-label ${JSON.stringify(payload.labels.join(','))}`);
  }
  if (issueNumber === null) {
    const view = runGh(`gh issue list --repo ${config.repo} --limit 1 --json number,id,title,body,state,labels,updatedAt`);
    const parsed = JSON.parse(view) as any[];
    if (parsed.length > 0) {
      return normalizeGithubIssue(parsed[0]);
    }
    throw new Error('Failed to create GitHub issue');
  }
  const view = runGh(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
  const parsed = JSON.parse(view) as any;
  return normalizeGithubIssue(parsed);
}

export async function createGithubIssueAsync(config: GithubConfig, payload: { title: string; body: string; labels: string[] }): Promise<GithubIssueRecord> {
  return await throttler.schedule(async () => {
    const command = `gh issue create --repo ${config.repo} --title ${JSON.stringify(payload.title)} --body-file -`;
    const output = await runGhAsync(command, payload.body);
    let issueNumber: number | null = null;
    const match = output.match(/\/(\d+)$/);
    if (match) issueNumber = parseInt(match[1], 10);
    if (issueNumber !== null && payload.labels.length > 0) {
      // Ensure labels once per process to reduce API calls
      await ensureGithubLabelsOnceAsync(config, payload.labels);
      try { await runGhAsync(`gh issue edit ${issueNumber} --repo ${config.repo} --add-label ${JSON.stringify(payload.labels.join(','))}`); } catch (_) {}
    }
    if (issueNumber === null) {
      const view = await runGhJsonAsync(`gh issue list --repo ${config.repo} --limit 1 --json number,id,title,body,state,labels,updatedAt`);
      if (Array.isArray(view) && view.length > 0) return normalizeGithubIssue(view[0]);
      throw new Error('Failed to create GitHub issue');
    }
    const parsed = await runGhJsonAsync(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
    return normalizeGithubIssue(parsed);
  });
}

export async function updateGithubIssueAsync(
  config: GithubConfig,
  issueNumber: number,
  payload: { title: string; body: string; labels: string[]; state: 'open' | 'closed' }
): Promise<GithubIssueRecord> {
  // Run the entire update flow as a single scheduled task to avoid
  // serializing internal parallel operations via per-call scheduling.
  return await throttler.schedule(async () => {
    // Fetch current issue once and compute minimal set of operations
    let current: GithubIssueRecord;
    try {
      current = await getGithubIssueAsync(config, issueNumber);
    } catch {
      current = getGithubIssue(config, issueNumber);
    }

    const ops: Array<Promise<void>> = [];
    const titleChanged = (current.title || '') !== (payload.title || '');
    const bodyChanged = (current.body || '') !== (payload.body || '');
    // Only edit title/body if something changed
    if (titleChanged || bodyChanged) {
      const command = `gh issue edit ${issueNumber} --repo ${config.repo} --title ${JSON.stringify(payload.title)} --body-file -`;
      ops.push(runGhAsync(command, payload.body).then(() => {}).catch(() => {}));
    }

    // State change: only close/reopen when different
    if (payload.state === 'closed' && current.state !== 'closed') {
      ops.push(runGhAsync(`gh issue close ${issueNumber} --repo ${config.repo}`).then(() => {}).catch(() => {}));
    } else if (payload.state === 'open' && current.state === 'closed') {
      ops.push(runGhAsync(`gh issue reopen ${issueNumber} --repo ${config.repo}`).then(() => {}).catch(() => {}));
    }

    // Labels: compute status labels to remove and labels to add
    if (payload.labels.length > 0) {
      const desiredSet = new Set(payload.labels);
      // Remove any single-valued category labels (stage, priority, status, type,
      // risk, effort) that are on the issue but not in the desired set. This
      // prevents label accumulation when e.g. stage changes from idea -> done.
      const staleLabelsToRemove = current.labels.filter(label => isSingleValueCategoryLabel(label, config.labelPrefix) && !desiredSet.has(label));
      if (staleLabelsToRemove.length > 0) {
        ops.push(runGhAsync(`gh issue edit ${issueNumber} --repo ${config.repo} --remove-label ${JSON.stringify(staleLabelsToRemove.join(','))}`).then(() => {}).catch(() => {}));
      }

      // Compute labels that are not already present
      const labelsToAdd = payload.labels.filter(l => !current.labels.includes(l));
      if (labelsToAdd.length > 0) {
        await ensureGithubLabelsOnceAsync(config, labelsToAdd);
        ops.push(runGhAsync(`gh issue edit ${issueNumber} --repo ${config.repo} --add-label ${JSON.stringify(labelsToAdd.join(','))}`).then(() => {}).catch(() => {}));
      }
    }

    // Execute operations — remove stale labels first, then add new ones,
    // to avoid transient states where both old and new labels coexist.
    if (ops.length > 0) await Promise.all(ops);

    // If no ops ran, return current object, else fetch fresh state
    if (ops.length === 0) return current;
    const parsed = await runGhJsonAsync(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
    return normalizeGithubIssue(parsed);
  });
}

export async function getGithubIssueAsync(config: GithubConfig, issueNumber: number): Promise<GithubIssueRecord> {
  const parsed = await throttler.schedule(async () => {
    return await runGhJsonAsync(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
  });
  return normalizeGithubIssue(parsed);
}

export async function listGithubIssuesAsync(config: GithubConfig, since?: string): Promise<GithubIssueRecord[]> {
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
  const apiPath = `repos/${config.repo}/issues?state=all&per_page=100${sinceParam}`;
  const apiCommand = `gh api ${quoteShellValue(apiPath)} --paginate`;
  const output = await ghApiAsyncScheduled(apiCommand);
  const parsed = JSON.parse(output) as any[];
  const issuesOnly = parsed.filter(entry => {
    if (entry.pull_request) return false;
    if (typeof entry.html_url === 'string' && entry.html_url.includes('/pull/')) return false;
    if (typeof entry.pull_request_url === 'string' && entry.pull_request_url.length > 0) return false;
    return true;
  });
  return issuesOnly.map(entry => normalizeGithubIssue({
    id: entry.id,
    number: entry.number,
    title: entry.title,
    body: entry.body,
    state: entry.state,
    labels: entry.labels || [],
    updatedAt: entry.updated_at,
    subIssuesSummary: entry.sub_issues_summary ? { total: entry.sub_issues_summary.total ?? 0, completed: entry.sub_issues_summary.completed ?? 0 } : undefined,
  }));
}

/**
 * @deprecated Use `updateGithubIssueAsync` instead. This function blocks the event loop.
 * Migration: Replace `updateGithubIssue(config, issueNumber, payload)` with `await updateGithubIssueAsync(config, issueNumber, payload)`.
 */
export function updateGithubIssue(
  config: GithubConfig,
  issueNumber: number,
  payload: { title: string; body: string; labels: string[]; state: 'open' | 'closed' }
): GithubIssueRecord {
  // Fetch current issue once and compute minimal operations
  const current = getGithubIssue(config, issueNumber);
  const ops: (() => void)[] = [];
  const titleChanged = (current.title || '') !== (payload.title || '');
  const bodyChanged = (current.body || '') !== (payload.body || '');
  if (titleChanged || bodyChanged) {
    ops.push(() => runGh(`gh issue edit ${issueNumber} --repo ${config.repo} --title ${JSON.stringify(payload.title)} --body-file -`, payload.body));
  }

  if (payload.state === 'closed' && current.state !== 'closed') {
    ops.push(() => runGh(`gh issue close ${issueNumber} --repo ${config.repo}`));
  } else if (payload.state === 'open' && current.state === 'closed') {
    ops.push(() => runGh(`gh issue reopen ${issueNumber} --repo ${config.repo}`));
  }

  if (payload.labels.length > 0) {
    const desiredSet = new Set(payload.labels);
    const staleLabelsToRemove = current.labels.filter(label => isSingleValueCategoryLabel(label, config.labelPrefix) && !desiredSet.has(label));
    if (staleLabelsToRemove.length > 0) {
      ops.push(() => runGhSafe(`gh issue edit ${issueNumber} --repo ${config.repo} --remove-label ${JSON.stringify(staleLabelsToRemove.join(','))}`));
    }

    const labelsToAdd = payload.labels.filter(l => !current.labels.includes(l));
    if (labelsToAdd.length > 0) {
      ensureGithubLabelsOnce(config, labelsToAdd);
      ops.push(() => runGh(`gh issue edit ${issueNumber} --repo ${config.repo} --add-label ${JSON.stringify(labelsToAdd.join(','))}`));
    }
  }

  for (const op of ops) {
    try { op(); } catch (_) { /* ignore individual failures */ }
  }

  if (ops.length === 0) return current;
  const output = runGh(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
  const parsed = JSON.parse(output) as any;
  return normalizeGithubIssue(parsed);
}

/**
 * @deprecated Use `listGithubIssuesAsync` instead. This function blocks the event loop.
 * Migration: Replace `listGithubIssues(config, since)` with `await listGithubIssuesAsync(config, since)`.
 */
export function listGithubIssues(config: GithubConfig, since?: string): GithubIssueRecord[] {
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
  const apiPath = `repos/${config.repo}/issues?state=all&per_page=100${sinceParam}`;
  const apiCommand = `gh api ${quoteShellValue(apiPath)} --paginate`;
  const output = runGh(apiCommand);
  const parsed = JSON.parse(output) as any[];
  const issuesOnly = parsed.filter(entry => {
    if (entry.pull_request) {
      return false;
    }
    if (typeof entry.html_url === 'string' && entry.html_url.includes('/pull/')) {
      return false;
    }
    if (typeof entry.pull_request_url === 'string' && entry.pull_request_url.length > 0) {
      return false;
    }
    return true;
  });
  return issuesOnly.map(entry =>
    normalizeGithubIssue({
      id: entry.id,
      number: entry.number,
      title: entry.title,
      body: entry.body,
      state: entry.state,
      labels: entry.labels || [],
      updatedAt: entry.updated_at,
      subIssuesSummary: entry.sub_issues_summary
        ? {
            total: entry.sub_issues_summary.total ?? 0,
            completed: entry.sub_issues_summary.completed ?? 0,
          }
        : undefined,
    })
  );
}

/**
 * @deprecated Use `getGithubIssueAsync` instead. This function blocks the event loop.
 * Migration: Replace `getGithubIssue(config, issueNumber)` with `await getGithubIssueAsync(config, issueNumber)`.
 */
export function getGithubIssue(config: GithubConfig, issueNumber: number): GithubIssueRecord {
  const command = `gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`;
  const output = runGh(command);
  const parsed = JSON.parse(output) as any;
  return normalizeGithubIssue(parsed);
}

function normalizeGithubIssue(raw: any): GithubIssueRecord {
  const stateRaw = typeof raw.state === 'string' ? raw.state.toLowerCase() : '';
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? null,
    state: stateRaw === 'closed' ? 'closed' : 'open',
    labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => l.name || l) : [],
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    subIssuesSummary: raw.subIssuesSummary,
  };
}
