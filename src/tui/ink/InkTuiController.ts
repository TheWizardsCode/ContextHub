/**
 * InkTuiController — thin wrapper that renders the Ink-based TUI App.
 *
 * Mirrors the interface of the Blessed TuiController so that the CLI
 * command (src/commands/tui.ts) can instantiate either backend with
 * minimal changes.
 */

import React from 'react';
import { render } from 'ink';
import type { PluginContext } from '../../plugin-types.js';
import type { WorkItem } from '../../types.js';
import { App } from './App.js';

export interface InkTuiOptions {
  inProgress?: boolean;
  prefix?: string;
  all?: boolean;
  perf?: boolean;
}

export class InkTuiController {
  private ctx: PluginContext;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  async start(options: InkTuiOptions = {}): Promise<void> {
    const db = this.ctx.utils.getDatabase(options.prefix);

    // Load work items from the database
    const rawItems = db.getAll();
    const items: WorkItem[] = Array.isArray(rawItems) ? rawItems : [];

    // Determine which items to show
    const filtered = (() => {
      if (options.inProgress) {
        return items.filter((i: WorkItem) => i.status === 'in-progress');
      }
      if (!options.all) {
        return items.filter((i: WorkItem) => i.status !== 'completed' && i.status !== 'deleted');
      }
      return items;
    })();

    const onRefresh = async (): Promise<WorkItem[]> => {
      const refreshed = db.getAll();
      const all: WorkItem[] = Array.isArray(refreshed) ? refreshed : [];
      if (options.inProgress) {
        return all.filter((i: WorkItem) => i.status === 'in-progress');
      }
      if (!options.all) {
        return all.filter((i: WorkItem) => i.status !== 'completed' && i.status !== 'deleted');
      }
      return all;
    };

    const columns = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 30;

    const { waitUntilExit } = render(
      React.createElement(App, {
        items: filtered,
        onRefresh,
        columns,
        rows,
      }),
    );

    await waitUntilExit();
  }
}
