/**
 * lib/auto-inject.ts — Auto-injection of relevant work items before agent turns.
 *
 * Registers a `before_agent_start` handler that:
 * 1. Extracts work item IDs from the user's prompt
 * 2. Searches for related work items via `wl search`
 * 3. Formats matching items as context
 * 4. Injects the formatted context into the system prompt
 * 5. Sets a status bar indicator when items are injected
 *
 * Configuration:
 * - `autoInjectEnabled` (boolean): Master enable/disable toggle (default: true)
 *   Set via the `context-hub` settings namespace in `.pi/settings.json`.
 *
 * Features:
 * - **ID Detection**: Auto-detect work item IDs in prompts (e.g., WL-0MQL0T5TR0060AEH)
 * - **Context Search**: Find related items by title/description/keyword matching
 * - **Smart Injection**: Only inject when relevant items are found
 * - **Full-Detail Mode**: Shows ID, title, status, priority, and stage (up to `MAX_FULL_DETAIL` items)
 * - **Links-Only Mode**: Compact ID + title list for larger result sets
 * - **Configurable**: Enable/disable via settings
 * - **Status Indicator**: Brief status bar notification showing injection count
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { runWl } from '../../wl-integration.js';
import { currentSettings } from './settings.js';

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Max items in full-detail mode. Above this, links-only mode is used.
 */
const MAX_FULL_DETAIL = 3;

/**
 * Max results returned by the `wl search` call.
 */
const MAX_SEARCH_RESULTS = 5;

/**
 * Regex to detect work item ID patterns in user input.
 *
 * Matches patterns like `WL-0MQL0T5TR0060AEH` (prefix + dash + 15+ alphanumeric chars).
 * The prefix must be 2-3 uppercase letters followed by a dash and at least 15
 * alphanumeric characters. This is intentionally conservative to avoid false
 * positives on ordinary text while matching all known work item ID formats.
 */
const WORK_ITEM_ID_REGEX = /\b[A-Z]{2,3}-[A-Z0-9]{15,}/g;

/**
 * Status key used for the auto-injection indicator in the footer.
 * Passed to `ctx.ui.setStatus()` to set and clear the indicator.
 */
const AUTO_INJECT_STATUS_KEY = 'worklog-auto-inject';

// ── Extraction ────────────────────────────────────────────────────────

/**
 * Extract all unique work item IDs from the given text.
 *
 * Scans the text for patterns matching work item IDs (e.g., WL-0MQL0T5TR0060AEH)
 * and returns all unique matches in order of first appearance.
 *
 * @param text - The text to scan for work item IDs
 * @returns An array of unique work item IDs, or an empty array if none found
 *
 * @example
 * extractWorkItemIds('Implement WL-0MQL0T5TR0060AEH')           // => ['WL-0MQL0T5TR0060AEH']
 * extractWorkItemIds('Fix WL-A and WL-B')                       // => ['WL-A', 'WL-B']
 * extractWorkItemIds('No IDs here')                             // => []
 */
export function extractWorkItemIds(text: string): string[] {
  const matches = text.match(WORK_ITEM_ID_REGEX);
  if (!matches || matches.length === 0) return [];
  // Deduplicate while preserving order of first appearance
  return [...new Set(matches)];
}

// ── Types ────────────────────────────────────────────────────────────

/**
 * A simplified work item shape used for context injection.
 */
export interface WorkItemSummary {
  id: string;
  title: string;
  status: string;
  priority?: string;
  stage?: string;
}

/**
 * Normalize a raw wl CLI result (from `wl show` or `wl search`) into a
 * WorkItemSummary.
 */
function normalizeWorkItem(raw: unknown): WorkItemSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = obj.id ? String(obj.id) : '';
  if (!id) return null;
  return {
    id,
    title: obj.title ? String(obj.title) : 'Untitled',
    status: obj.status ? String(obj.status) : 'unknown',
    priority: obj.priority ? String(obj.priority) : undefined,
    stage: obj.stage ? String(obj.stage) : undefined,
  };
}

// ── Search ────────────────────────────────────────────────────────────

/**
 * Interface for the wl runner function, allowing injection for testability.
 */
export interface WlRunner {
  (command: string, args?: string[]): Promise<unknown>;
}

/**
 * Search for related work items based on the prompt context.
 *
 * 1. Fetches explicitly referenced IDs via `wl show`
 * 2. Searches by prompt context keywords via `wl search`
 * 3. Deduplicates results
 *
 * @param prompt - The user's prompt text
 * @param existingIds - Work item IDs already extracted from the prompt
 * @param runWlFn - The wl runner function (injected for testability; defaults to
 *   the real runWl from wl-integration)
 * @returns A deduplicated array of matching work items
 */
export async function searchRelatedWorkItems(
  prompt: string,
  existingIds: string[],
  runWlFn: WlRunner = runWl as unknown as WlRunner,
): Promise<WorkItemSummary[]> {
  const results: Map<string, WorkItemSummary> = new Map();

  // 1. Fetch explicitly referenced IDs via wl show
  for (const id of existingIds) {
    try {
      const payload = await runWlFn('show', [id]);
      if (payload && typeof payload === 'object') {
        const item = normalizeWorkItem(payload);
        if (item) {
          results.set(item.id, item);
        }
      }
    } catch {
      // Silently skip invalid/missing IDs — the ID may be stale or from
      // a different session. No error is surfaced to the user.
    }
  }

  // 2. Search by prompt context — only if there's meaningful text beyond IDs
  // Strip out any work item IDs so we search by the actual semantic content.
  const cleanedPrompt = prompt.replace(/\b[A-Z]{2,3}-[A-Z0-9]{15,}/g, '').trim();
  if (cleanedPrompt.length >= 3) {
    try {
      const payload = await runWlFn('search', [cleanedPrompt, '--limit', String(MAX_SEARCH_RESULTS)]);
      if (payload && typeof payload === 'object') {
        const payloadObj = payload as Record<string, unknown>;
        const searchResults = Array.isArray(payloadObj.results) ? payloadObj.results : [];
        for (const entry of searchResults) {
          const item = normalizeWorkItem(entry);
          if (item && !results.has(item.id)) {
            results.set(item.id, item);
          }
        }
      }
    } catch {
      // Silently skip search errors — the wl CLI may not be available or
      // the search index may not be built. Graceful degradation.
    }
  }

  return [...results.values()];
}

// ── Formatting ────────────────────────────────────────────────────────

/**
 * Format a list of work items as a markdown context block for system prompt
 * injection.
 *
 * In **full-detail mode** (up to `MAX_FULL_DETAIL` items), shows each item
 * with ID, title, status, priority, and stage as inline tags:
 *
 * ```markdown
 * ## Relevant Work Items
 *
 * - **WL-123**: Fix login bug `high` `open` `in_progress`
 * - **WL-456**: Add tests `medium` `in_review`
 * ```
 *
 * For larger result sets, a compact **links-only** list is used:
 *
 * ```markdown
 * ## Relevant Work Items
 *
 * - WL-123: Fix login bug
 * - WL-456: Add tests
 * ```
 *
 * @param items - The work items to format (may be empty)
 * @returns A formatted markdown string, or an empty string if no items
 */
export function formatWorkItemContext(items: WorkItemSummary[]): string {
  if (items.length === 0) return '';

  const header = '## Relevant Work Items\n';

  if (items.length <= MAX_FULL_DETAIL) {
    // Full-detail mode: show ID, title, and inline tags
    const details = items
      .map((item) => {
        const tags = [item.priority, item.status, item.stage]
          .filter((t): t is string => Boolean(t))
          .map((t) => `\`${t}\``)
          .join(' ');
        return `- **${item.id}**: ${item.title} ${tags}`;
      })
      .join('\n');
    return `${header}\n${details}\n`;
  }

  // Links-only mode: compact ID + title list
  const links = items.map((item) => `- ${item.id}: ${item.title}`).join('\n');
  return `${header}\n${links}\n`;
}

// ── Registration ──────────────────────────────────────────────────────

/**
 * Register the auto-injection handler with a Pi extension instance.
 *
 * Sets up a `before_agent_start` handler that:
 * 1. Checks if auto-injection is enabled in settings
 * 2. Extracts work item IDs from the prompt text
 * 3. Searches for related work items via `wl search`
 * 4. Formats matching items as markdown context
 * 5. Appends the context to the system prompt
 * 6. Sets a status bar indicator showing how many items were injected
 *
 * When auto-injection is disabled via settings, the handler is a no-op.
 * When no related items are found, the handler returns without modifying
 * the system prompt.
 *
 * @param pi - The ExtensionAPI instance
 */
export function registerAutoInject(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event, ctx) => {
    // Check if auto-injection is enabled in settings
    if (!currentSettings.autoInjectEnabled) return;

    const prompt = event.prompt || '';

    // Extract work item IDs from the prompt text
    const workItemIds = extractWorkItemIds(prompt);

    // Search for related work items by ID lookup and context search
    const relatedItems = await searchRelatedWorkItems(prompt, workItemIds);

    // Only inject if we found relevant items
    if (relatedItems.length > 0) {
      const context = formatWorkItemContext(relatedItems);
      const updatedSystemPrompt = event.systemPrompt + '\n\n' + context;

      // Set a status bar indicator showing injection count
      const count = relatedItems.length;
      const noun = count === 1 ? 'item' : 'items';
      ctx.ui.setStatus(AUTO_INJECT_STATUS_KEY, `📋 ${count} ${noun} auto-injected`);

      return { systemPrompt: updatedSystemPrompt };
    }
  });
}
