/**
 * Worklog browser extension — thin orchestration layer.
 *
 * Registers the /wl command, ctrl+shift+b shortcut, and session lifecycle
 * hooks. All substantive logic is in lib/ modules.
 *
 * Moved from extensions/index.ts to extensions/Worklog/index.ts so that Pi
 * derives the display label "Worklog" from the entry-point path.
 */

import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { ShortcutRegistry } from './shortcut-config.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { registerActivityIndicator, showActivity, clearActivity } from './activity-indicator.js';
import { worklogConfig } from './config.js';
import { reloadSettings, currentSettings, STAGE_MAP, VALID_STAGES, updateSettings, openSettingsOverlay } from './lib/settings.js';
import { runWl, defaultListWorkItems, defaultListWorkItemsWithStage, createDefaultListWorkItems, createListWorkItemsWithStage, createDefaultListWorkItemsDb, createListWorkItemsWithStageDb, fetchTotalActionableCountDb } from './lib/tools.js';
import { registerAutoInject } from './lib/auto-inject.js';
import { INSTALL_GUARDRAILS } from './lib/guardrails.js';
import { registerSkillPathTool } from './lib/skill-path.js';
import {
  type WorklogBrowseItem,
  type WorklogBrowseDependencies,
  type BrowseContext,
  type ShortcutResult,
  type SelectionChangeHandler,
  type BrowseFlowOptions,
  runBrowseFlow,
  buildSelectionWidget,
  formatBrowseOption,
  createScrollableWidget,
  getIconPrefix,
} from './lib/browse.js';

// ── Backward-compatible re-exports ────────────────────────────────────
export type { WorklogBrowseItem, SelectionChangeHandler };

export {
  defaultChooseWorkItem,
} from './lib/browse.js';

export {
  buildSelectionWidget,
  getIconPrefix,
  formatBrowseOption,
  createScrollableWidget,

  updateSettings,
  STAGE_MAP,
};

// Re-export list work item factories for tests and external consumers
export {
  createDefaultListWorkItems,
  createListWorkItemsWithStage,
} from './lib/tools.js';

// Icons — resolved via symlink-safe createRequire
const _require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const { priorityIcon, statusIcon, stageIcon, auditIcon, epicIcon, iconsEnabled, riskIcon, effortIcon } = _require('../../../../dist/icons.js');

export function createWorklogBrowseExtension(deps: WorklogBrowseDependencies = {}) {
  const runWlImpl = deps.runWl ?? runWl;
  // Use CLI-backed list operations (wl next) so grouping, sorting, and
  // other CLI-side logic is always applied.
  const listWorkItems = deps.listWorkItems ?? createDefaultListWorkItems();
  const listWorkItemsWithStage = deps.listWorkItemsWithStage ?? createListWorkItemsWithStage();
  const shortcutRegistry = deps.shortcutRegistry ?? loadShortcutConfig();
  const chooseWorkItem = deps.chooseWorkItem
    ? (deps.chooseWorkItem as (items: WorklogBrowseItem[], ctx: BrowseContext, onSelectionChange: SelectionChangeHandler) => Promise<WorklogBrowseItem | ShortcutResult | undefined>)
    : undefined;

  const browseOptions: BrowseFlowOptions = {
    listWorkItems,
    listWorkItemsWithStage,
    runWlImpl,
    shortcutRegistry,
    chooseWorkItem,
    // Phase 2: Pre-fetched actionable count from direct DB access.
    // When undefined (DB unavailable), browse falls back to CLI-based count.
    totalActionableCount: undefined,
  };

  return function registerWorklogBrowseExtension(pi: ExtensionAPI): void {
    registerActivityIndicator(pi, () => currentSettings.showActivityIndicator);
    registerAutoInject(pi);
    INSTALL_GUARDRAILS(pi, { enabled: currentSettings.guardrailsEnabled });

    // ── Skill path discovery tool ─────────────────────────────────
    if (typeof pi.registerTool === 'function') {
      pi.registerTool(registerSkillPathTool());
    }

    // Subscribe to config changes for hot-reload notifications
    // When settings change via /wl settings or file edit, all onChange
    // subscribers are notified immediately without requiring /reload.
    worklogConfig.onChange(() => {
      // currentSettings is already updated; components that read it
      // dynamically (e.g., activity indicator getter) pick up changes.
      // Future: re-install guardrails when guardrailsEnabled changes.
    });

    pi.registerCommand('wl', {
      description: `Browse next ${currentSettings.browseItemCount} work items, optionally filtered by stage and settings`,
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        showActivity(ctx as any, '/wl', currentSettings.showActivityIndicator);
        const trimmed = _args?.trim() ?? '';
        if (trimmed.length === 0) {
          await runBrowseFlow(ctx as unknown as BrowseContext, browseOptions);
          return;
        }
        if (trimmed === 'settings') {
          await openSettingsOverlay(ctx as unknown as BrowseContext);
          return;
        }
        const canonical = STAGE_MAP[trimmed];
        if (canonical) {
          await runBrowseFlow(ctx as unknown as BrowseContext, browseOptions, canonical);
          return;
        }
        ctx.ui.notify(`Unknown stage value: '${trimmed}'`, 'error');
        await runBrowseFlow(ctx as unknown as BrowseContext, browseOptions);
      },
      getArgumentCompletions: (prefix: string) => {
        const allCompletions = ['settings', ...Object.keys(STAGE_MAP)].sort();
        const filtered = allCompletions.filter(s => s.startsWith(prefix));
        return filtered.length > 0
          ? filtered.map(s => ({ value: s, label: s }))
          : null;
      },
    });

    pi.registerShortcut('ctrl+shift+b', {
      description: `Browse next ${currentSettings.browseItemCount} recommended work items and preview selected title`,
      handler: async (ctx: ExtensionCommandContext) => {
        showActivity(ctx as any, '/wl', currentSettings.showActivityIndicator);
        await runBrowseFlow(ctx as unknown as BrowseContext, browseOptions);
      },
    });

    // ── Session persistence ────────────────────────────────────────
    pi.on('session_start', async () => {
      reloadSettings();
    });

    pi.on('session_tree', async () => {
      reloadSettings();
    });

    // Auto-trigger browse flow on session_start when launched via `wl piman`
    if (typeof process !== 'undefined' && process.env?.WL_PIMAN === '1') {
      pi.on('session_start', (_event, ctx) => {
        setTimeout(() => {
          void runBrowseFlow(ctx as unknown as BrowseContext, browseOptions);
        }, 500);
      });
    }
  };
}

export default createWorklogBrowseExtension();
