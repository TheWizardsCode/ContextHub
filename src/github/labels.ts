/**
 * src/github/labels.ts — the label concern of the GitHub integration.
 *
 * Concern: everything about labels — prefix normalisation
 * (`normalizeGithubLabelPrefix`), deterministic colour derivation
 * (`labelColor`), the single-value category predicates (`isStatusLabel`,
 * `isSingleValueCategoryLabel` and the `SINGLE_VALUE_LABEL_CATEGORIES` list),
 * the label-ensuring paths and their two process caches (`ensureGithubLabels`,
 * `ensureGithubLabelsAsync`, `ensureGithubLabelsOnce`,
 * `ensureGithubLabelsOnceAsync`, `existingLabelsCache`, `ensuredLabelsCache`),
 * and the label-event read path (`LabelEventCache`, `fetchLabelEventsAsync`,
 * `labelFieldsDiffer`, `getLatestLabelEventTimestamp`).
 *
 * Moved verbatim from `src/github.ts` (WL-0MVVLXY42003Q047, child 4 of 8 of the
 * WL-0MVGKGR2H006MNVG `src/github.ts` decomposition). Move-only: no label name,
 * colour hash, cache or GraphQL/REST call change, and the deprecated
 * synchronous paths keep their `@deprecated` JSDoc. Only the six symbols that
 * are public today (`normalizeGithubLabelPrefix`, `isSingleValueCategoryLabel`,
 * `LabelEventCache`, `fetchLabelEventsAsync`, `labelFieldsDiffer`,
 * `getLatestLabelEventTimestamp`) are re-exported by the `src/github.ts`
 * barrel; the remaining helpers (`labelColor`, `isStatusLabel`,
 * `ensureGithubLabels`, `ensureGithubLabelsAsync`, `ensureGithubLabelsOnce`,
 * `ensureGithubLabelsOnceAsync`) are exported here for internal use by sibling
 * modules and are NOT part of the public surface.
 *
 * Dependency direction: this module imports the family leaves `./types.js`,
 * `./transport.js` and `./repo-slug.js`, plus — for the shared status and
 * priority unions only — the root declaration module `../types.js` (type-only).
 * It never imports the `../github.js` barrel, so the family's import graph
 * stays acyclic.
 */

import type { WorkItemPriority, WorkItemStatus } from '../types.js';
import { parseRepoSlug } from './repo-slug.js';
import { ghApiAsyncScheduled, ghApiJsonScheduled, runGhSafe } from './transport.js';
import type { GithubConfig, LabelEvent } from './types.js';

export function labelColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  const color = (hash % 0xffffff).toString(16).padStart(6, '0');
  return color === '000000' ? 'ededed' : color;
}

/**
 * Known worklog label categories that should be single-valued on an issue.
 * When a new value is pushed for one of these categories the old label must
 * be removed first to avoid label accumulation.
 *
 * `tag:` is intentionally excluded — multiple tags are valid and additive.
 */
const SINGLE_VALUE_LABEL_CATEGORIES = ['status:', 'priority:', 'stage:', 'type:', 'risk:', 'effort:'] as const;

export function isStatusLabel(label: string, labelPrefix: string): boolean {
  const normalizedPrefix = normalizeGithubLabelPrefix(labelPrefix);
  if (!label.startsWith(normalizedPrefix)) {
    return false;
  }
  const value = label.slice(normalizedPrefix.length);
  if (value.startsWith('status:')) {
    return true;
  }
  return value === 'open' || value === 'in-progress' || value === 'completed' || value === 'blocked' || value === 'deleted';
}

/**
 * Returns true when `label` is a worklog single-valued category label (e.g.
 * `wl:stage:idea`, `wl:priority:high`) or a bare legacy status label (e.g.
 * `wl:open`).
 *
 * Tags (`wl:tag:*`) are excluded because multiple tags are valid on a single
 * issue.
 */
export function isSingleValueCategoryLabel(label: string, labelPrefix: string): boolean {
  const normalizedPrefix = normalizeGithubLabelPrefix(labelPrefix);
  if (!label.startsWith(normalizedPrefix)) {
    return false;
  }
  const value = label.slice(normalizedPrefix.length);

  // Check known single-value categories
  for (const cat of SINGLE_VALUE_LABEL_CATEGORIES) {
    if (value.startsWith(cat)) {
      return true;
    }
  }

  // Legacy bare status values (e.g. wl:open, wl:in-progress)
  if (value === 'open' || value === 'in-progress' || value === 'completed' || value === 'blocked' || value === 'deleted') {
    return true;
  }

  return false;
}

/**
 * @deprecated Use `ensureGithubLabelsAsync` instead. This function blocks the event loop.
 * Migration: Replace `ensureGithubLabels(config, labels)` with `await ensureGithubLabelsAsync(config, labels)`.
 */
export function ensureGithubLabels(config: GithubConfig, labels: string[]): void {
  const unique = Array.from(new Set(labels.filter(label => label.trim() !== '')));
  if (unique.length === 0) {
    return;
  }

  const { owner, name } = parseRepoSlug(config.repo);
  // Load existing labels once per process for this repo and reuse it.
  let existing = existingLabelsCache.get(config.repo);
  if (existing === undefined && !existingLabelsCache.has(config.repo)) {
    // Not fetched yet for this process - attempt to fetch and cache result.
    const existingRaw = runGhSafe(`gh api repos/${owner}/${name}/labels --paginate`);
    if (existingRaw) {
      const parsedSet = new Set<string>();
      try {
        const parsed = JSON.parse(existingRaw) as Array<{ name?: string }>;
        for (const entry of parsed) {
          if (entry.name) parsedSet.add(entry.name);
        }
      } catch {
        // If parsing fails, fall back to an empty set but mark as fetched so we don't refetch.
      }
      existingLabelsCache.set(config.repo, parsedSet);
      existing = parsedSet;
    } else {
      // Mark as fetched but empty to avoid repeated failing API calls.
      existingLabelsCache.set(config.repo, new Set<string>());
      existing = existingLabelsCache.get(config.repo)!;
    }
  }
  // Ensure we have a Set to consult
  if (!existing) existing = new Set<string>();

  for (const label of unique) {
    if (existing.has(label)) {
      continue;
    }
    const color = labelColor(label);
    const createCommand = `gh api -X POST repos/${owner}/${name}/labels -f name=${JSON.stringify(label)} -f color=${JSON.stringify(color)}`;
    const result = runGhSafe(createCommand);
    if (result !== null) {
      // Update cached set so subsequent calls in this process know the label exists.
      try { existing.add(label); } catch (_) {}
      continue;
    }
    const fallbackCommand = `gh issue label create ${JSON.stringify(label)} --repo ${config.repo} --color ${color}`;
    runGhSafe(fallbackCommand);
    try { existing.add(label); } catch (_) {}
  }
}

export function normalizeGithubLabelPrefix(prefix?: string): string {
  if (!prefix) return 'wl:';
  return prefix.endsWith(':') ? prefix : `${prefix}:`;
}

export async function ensureGithubLabelsAsync(config: GithubConfig, labels: string[]): Promise<void> {
  const unique = Array.from(new Set(labels.filter(label => label.trim() !== '')));
  if (unique.length === 0) return;
  const { owner, name } = parseRepoSlug(config.repo);
  try {
    // Reuse per-process cache if available, otherwise fetch once and cache.
    let existing = existingLabelsCache.get(config.repo);
    if (existing === undefined && !existingLabelsCache.has(config.repo)) {
      try {
        const existingRaw = await ghApiJsonScheduled(`gh api repos/${owner}/${name}/labels --paginate`);
        const parsedSet = new Set<string>();
        if (existingRaw) {
          for (const entry of existingRaw) {
            if (entry?.name) parsedSet.add(entry.name);
          }
        }
        existingLabelsCache.set(config.repo, parsedSet);
        existing = parsedSet;
      } catch {
        // If fetch fails, cache an empty set to avoid repeated attempts.
        existingLabelsCache.set(config.repo, new Set<string>());
        existing = existingLabelsCache.get(config.repo)!;
      }
    }
    if (!existing) existing = new Set<string>();

    for (const label of unique) {
      if (existing.has(label)) continue;
      const color = labelColor(label);
      const createCommand = `gh api -X POST repos/${owner}/${name}/labels -f name=${JSON.stringify(label)} -f color=${JSON.stringify(color)}`;
        try {
          await ghApiAsyncScheduled(createCommand);
          existing.add(label);
          continue;
        } catch {
          const fallbackCommand = `gh issue label create ${JSON.stringify(label)} --repo ${config.repo} --color ${color}`;
          try { await ghApiAsyncScheduled(fallbackCommand); existing.add(label); } catch (_) { /* ignore */ }
        }
    }
  } catch {
    // ignore label creation failures
  }
}

// Per-process cache to avoid repeatedly ensuring the same labels for the same repo
const ensuredLabelsCache = new Map<string, Set<string>>();
// Cache of existing repo labels fetched from GitHub. Keyed by repo (owner/name).
// When populated it avoids calling the labels API repeatedly during a single process run.
const existingLabelsCache: Map<string, Set<string> | undefined> = new Map();

/**
 * @deprecated Use `ensureGithubLabelsOnceAsync` instead. This function blocks the event loop.
 * Migration: Replace `ensureGithubLabelsOnce(config, labels)` with `await ensureGithubLabelsOnceAsync(config, labels)`.
 */
export function ensureGithubLabelsOnce(config: GithubConfig, labels: string[]): void {
  const unique = Array.from(new Set(labels.filter(label => label.trim() !== '')));
  if (unique.length === 0) return;
  const cacheKey = config.repo;
  let cache = ensuredLabelsCache.get(cacheKey);
  if (!cache) {
    cache = new Set<string>();
    ensuredLabelsCache.set(cacheKey, cache);
  }
  const missing = unique.filter(l => !cache!.has(l));
  if (missing.length === 0) return;
  ensureGithubLabels(config, missing);
  for (const l of missing) cache.add(l);
}

export async function ensureGithubLabelsOnceAsync(config: GithubConfig, labels: string[]): Promise<void> {
  const unique = Array.from(new Set(labels.filter(label => label.trim() !== '')));
  if (unique.length === 0) return;
  const cacheKey = config.repo;
  let cache = ensuredLabelsCache.get(cacheKey);
  if (!cache) {
    cache = new Set<string>();
    ensuredLabelsCache.set(cacheKey, cache);
  }
  const missing = unique.filter(l => !cache!.has(l));
  if (missing.length === 0) return;
  await ensureGithubLabelsAsync(config, missing);
  for (const l of missing) cache.add(l);
}

// ---------------------------------------------------------------------------
// Label event fetching and caching for import conflict resolution
// ---------------------------------------------------------------------------

/**
 * In-memory cache for label events, scoped to a single import run.
 * Prevents redundant API calls for the same issue within one run.
 */
export class LabelEventCache {
  private cache = new Map<number, LabelEvent[]>();

  has(issueNumber: number): boolean {
    return this.cache.has(issueNumber);
  }

  get(issueNumber: number): LabelEvent[] | undefined {
    return this.cache.get(issueNumber);
  }

  set(issueNumber: number, events: LabelEvent[]): void {
    this.cache.set(issueNumber, events);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Fetch label events for a GitHub issue via the events API endpoint.
 *
 * Filters events to only those with action='labeled' or action='unlabeled'
 * where the label name starts with the configured prefix.
 *
 * Uses the in-memory cache to avoid redundant API calls within a single
 * import run. Falls back to an empty array on API failure.
 *
 * @param config - GitHub configuration with repo and label prefix
 * @param issueNumber - The issue number to fetch events for
 * @param cache - In-memory cache scoped to the import run
 * @returns Array of filtered label events, sorted by createdAt ascending
 */
export async function fetchLabelEventsAsync(
  config: GithubConfig,
  issueNumber: number,
  cache: LabelEventCache
): Promise<LabelEvent[]> {
  // Return cached result if available
  const cached = cache.get(issueNumber);
  if (cached !== undefined) {
    return cached;
  }

  const { owner, name } = parseRepoSlug(config.repo);
  const normalizedPrefix = normalizeGithubLabelPrefix(config.labelPrefix);

  try {
    const command = `gh api repos/${owner}/${name}/issues/${issueNumber}/events --paginate`;
    const data = await ghApiJsonScheduled(command);

    if (!Array.isArray(data)) {
      // API failure — cache empty array to avoid retrying in same run
      cache.set(issueNumber, []);
      return [];
    }

    const labelEvents: LabelEvent[] = [];
    for (const event of data) {
      const action = event?.event;
      if (action !== 'labeled' && action !== 'unlabeled') {
        continue;
      }
      const labelName = event?.label?.name;
      if (typeof labelName !== 'string') {
        continue;
      }
      // Only include labels that match the worklog prefix
      if (!labelName.startsWith(normalizedPrefix)) {
        continue;
      }
      const createdAt = event?.created_at;
      if (typeof createdAt !== 'string') {
        continue;
      }
      labelEvents.push({
        label: labelName,
        action,
        createdAt,
      });
    }

    // Sort by createdAt ascending for consistent ordering
    labelEvents.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    cache.set(issueNumber, labelEvents);
    return labelEvents;
  } catch {
    // On any error, cache empty array and return it
    cache.set(issueNumber, []);
    return [];
  }
}

/**
 * Check whether label-derived fields from a GitHub issue differ from local
 * work item values. Used to determine whether event fetching is necessary.
 *
 * @param labelFields - Fields extracted from GitHub issue labels
 * @param localItem - The local work item to compare against
 * @returns true if any label-derived field differs from the local value
 */
export function labelFieldsDiffer(
  labelFields: { status: WorkItemStatus; priority: WorkItemPriority; stage: string; issueType: string; risk: string; effort: string },
  localItem: { status: WorkItemStatus; priority: WorkItemPriority; stage: string; issueType: string; risk: string; effort: string }
): boolean {
  if (labelFields.status !== localItem.status) return true;
  if (labelFields.priority !== localItem.priority) return true;
  if (labelFields.stage && labelFields.stage !== localItem.stage) return true;
  if (labelFields.issueType && labelFields.issueType !== localItem.issueType) return true;
  if (labelFields.risk && labelFields.risk !== localItem.risk) return true;
  if (labelFields.effort && labelFields.effort !== localItem.effort) return true;
  return false;
}

/**
 * Get the most recent label event timestamp for a specific label category.
 * Looks through events for the last 'labeled' action matching the given
 * category prefix (e.g. 'stage:', 'priority:').
 *
 * @param events - Sorted array of label events (ascending by createdAt)
 * @param labelPrefix - The worklog label prefix (e.g. 'wl:')
 * @param category - The category to search for (e.g. 'stage:', 'priority:')
 * @returns The createdAt timestamp of the most recent matching event, or null
 */
export function getLatestLabelEventTimestamp(
  events: LabelEvent[],
  labelPrefix: string,
  category: string
): string | null {
  const normalizedPrefix = normalizeGithubLabelPrefix(labelPrefix);
  const fullPrefix = `${normalizedPrefix}${category}`;

  let latest: string | null = null;
  for (const event of events) {
    if (event.action === 'labeled' && event.label.startsWith(fullPrefix)) {
      latest = event.createdAt;
    }
  }
  return latest;
}
