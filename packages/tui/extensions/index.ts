/**
 * Worklog browser extension — thin orchestration layer.
 *
 * Registers the /wl command, ctrl+shift+b shortcut, and session lifecycle
 * hooks. All substantive logic is in lib/ modules.
 */

import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { ShortcutRegistry } from './shortcut-config.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { registerActivityIndicator, showActivity, clearActivity } from './activity-indicator.js';
import { reloadSettings, currentSettings, STAGE_MAP, VALID_STAGES, updateSettings, openSettingsOverlay } from './lib/settings.js';
import { runWl, defaultListWorkItems, defaultListWorkItemsWithStage, createDefaultListWorkItems, createListWorkItemsWithStage } from './lib/tools.js';
import {
  type WorklogBrowseItem,
  type WorklogBrowseDependencies,
  type BrowseContext,
  type ShortcutResult,
  type SelectionChangeHandler,
  type BrowseFlowOptions,
  defaultChooseWorkItem,
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
  buildSelectionWidget,
  getIconPrefix,
  formatBrowseOption,
  createScrollableWidget,
  createDefaultListWorkItems,
  createListWorkItemsWithStage,
  updateSettings,
  STAGE_MAP,
};

// Icons — resolved via symlink-safe createRequire
const _require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const { priorityIcon, statusIcon, stageIcon, auditIcon, epicIcon, iconsEnabled, riskIcon, effortIcon } = _require('../../../dist/icons.js');

export function createWorklogBrowseExtension(deps: WorklogBrowseDependencies = {}) {
  const runWlImpl = deps.runWl ?? runWl;
  const listWorkItems = deps.listWorkItems ?? (() => defaultListWorkItems(runWlImpl));
  const listWorkItemsWithStage = deps.listWorkItemsWithStage ?? ((stage: string) => defaultListWorkItemsWithStage(stage, runWlImpl));
  const shortcutRegistry = deps.shortcutRegistry ?? loadShortcutConfig();
  const chooseWorkItem = deps.chooseWorkItem
    ? (deps.chooseWorkItem as (items: WorklogBrowseItem[], ctx: BrowseContext, onSelectionChange: SelectionChangeHandler) => Promise<WorklogBrowseItem | ShortcutResult | undefined>)
    : (items: WorklogBrowseItem[], ctx: BrowseContext, onSelectionChange: SelectionChangeHandler) => defaultChooseWorkItem(items, ctx, onSelectionChange, shortcutRegistry);

  const browseOptions: BrowseFlowOptions = {
    listWorkItems,
    listWorkItemsWithStage,
    runWlImpl,
    shortcutRegistry,
    chooseWorkItem,
  };

  return function registerWorklogBrowseExtension(pi: ExtensionAPI): void {
    registerActivityIndicator(pi, () => currentSettings.showActivityIndicator);

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
