/**
 * Worklog Widget Extension for Pi TUI.
 *
 * Provides persistent widgets below the editor showing:
 * - worklog.list: numbered list of work items
 * - worklog.details: metadata and description for selected item
 *
 * Commands:
 *   /worklog show    - Display both widgets below the editor
 *   /worklog hide    - Remove both widgets
 *   /worklog-select <n|id> - Select by index or WL id
 *
 * Keyboard shortcuts (when widgets are visible):
 *   Ctrl+1..Ctrl+9  - Select work items 1-9
 *   Ctrl+Up/Down    - Cycle selection
 *
 * Usage:
 *   pi -e packages/tui/extensions/worklog-widgets.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { buildWorklogWidgetLines, buildWorklogDetailsLines, type WorkItem } from "./worklog-helpers.js";

// Re-export helpers for test consumers
export { buildWorklogWidgetLines, buildWorklogDetailsLines };

interface WidgetState {
  visible: boolean;
  items: WorkItem[];
  selectedIndex: number;
  error: string | null;
}

const state: WidgetState = {
  visible: false,
  items: [],
  selectedIndex: 0,
  error: null,
};

/**
 * Fetch work items by invoking the wl CLI.
 */
function fetchWorkItems(): { items: WorkItem[]; error: string | null } {
  try {
    const output = execSync("wl list --status open,in_progress --json -n 50", {
      encoding: "utf-8",
      timeout: 10000,
    });
    // wl list returns either a bare array or { workItems: [...] }
    let parsed: any;
    try {
      parsed = JSON.parse(output);
    } catch {
      return { items: [], error: "Failed to parse wl list output" };
    }
    const items: WorkItem[] = Array.isArray(parsed) ? parsed : (parsed.workItems ?? []);
    return { items, error: null };
  } catch (err: any) {
    return { items: [], error: err.message ?? "wl list failed" };
  }
}

/**
 * Refresh widgets with current data.
 */
function refreshWidgets(ctx: any) {
  const { items, error } = fetchWorkItems();
  state.items = items;
  state.error = error;
  if (state.selectedIndex >= items.length && items.length > 0) {
    state.selectedIndex = 0;
  }

  if (state.visible && ctx.ui && typeof ctx.ui.setWidget === "function") {
    const listWidth = Math.max(60, process.stdout.columns || 80);
    ctx.ui.setWidget("worklog.list", (_tui: any, theme: any) => ({
      render: (width: number) => {
        if (error) return [` Error: ${error}`];
        return buildWorklogWidgetLines(width, items, state.selectedIndex);
      },
      invalidate: () => refreshWidgets(ctx),
    }), { placement: "belowEditor" });

    const selectedItem = items[state.selectedIndex] ?? null;
    ctx.ui.setWidget("worklog.details", (_tui: any, theme: any) => ({
      render: (width: number) => buildWorklogDetailsLines(width, selectedItem),
      invalidate: () => {},
    }), { placement: "belowEditor" });
  }
}

/**
 * Pi extension entry point.
 */
export default function (pi: ExtensionAPI) {
  // Register /worklog show command
  pi.registerCommand("worklog", {
    description: "Show/hide worklog widgets or select an item",
    handler: async (args: string, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "hide") {
        state.visible = false;
        ctx.ui.setWidget("worklog.list", undefined);
        ctx.ui.setWidget("worklog.details", undefined);
        ctx.ui.notify("Worklog widgets hidden", "info");
        return;
      }

      if (trimmed === "show" || trimmed === "") {
        state.visible = true;
        refreshWidgets(ctx);
        ctx.ui.notify("Worklog widgets shown below editor", "info");
        return;
      }

      ctx.ui.notify("Usage: /worklog show | /worklog hide", "info");
    },
  });

  // Register /worklog-select command
  pi.registerCommand("worklog-select", {
    description: "Select a work item by index (1-9) or id",
    handler: async (args: string, ctx) => {
      if (!state.visible || state.items.length === 0) {
        ctx.ui.notify("Show worklog first with /worklog show", "info");
        return;
      }

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /worklog-select <1-9|id>", "info");
        return;
      }

      // Try numeric index
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= state.items.length) {
        state.selectedIndex = num - 1;
      } else {
        // Try work item ID match
        const idx = state.items.findIndex(item =>
          item.id.toLowerCase() === trimmed.toLowerCase() ||
          item.id.toLowerCase().endsWith(trimmed.toLowerCase())
        );
        if (idx >= 0) {
          state.selectedIndex = idx;
        } else {
          ctx.ui.notify(`No work item matching "${trimmed}"`, "error");
          return;
        }
      }

      refreshWidgets(ctx);
      const item = state.items[state.selectedIndex];
      ctx.ui.notify(`Selected: ${item.id} - ${item.title}`, "info");
    },
  });

  // Register keyboard shortcuts for selection
  for (let i = 1; i <= 9; i++) {
    pi.registerShortcut(`ctrl+${i}`, {
      description: `Select work item ${i}`,
      handler: async (ctx) => {
        if (!state.visible || state.items.length === 0) return;
        const idx = i - 1;
        if (idx < state.items.length) {
          state.selectedIndex = idx;
          refreshWidgets(ctx);
        }
      },
    });
  }

  pi.registerShortcut("ctrl+up", {
    description: "Cycle worklog selection up",
    handler: async (ctx) => {
      if (!state.visible || state.items.length === 0) return;
      state.selectedIndex = (state.selectedIndex - 1 + state.items.length) % state.items.length;
      refreshWidgets(ctx);
    },
  });

  pi.registerShortcut("ctrl+down", {
    description: "Cycle worklog selection down",
    handler: async (ctx) => {
      if (!state.visible || state.items.length === 0) return;
      state.selectedIndex = (state.selectedIndex + 1) % state.items.length;
      refreshWidgets(ctx);
    },
  });

  // On session start, fetch initial data (but don't show widgets until user requests)
  pi.on("session_start", async (_event, ctx) => {
    const { items, error } = fetchWorkItems();
    state.items = items;
    state.error = error;
  });
}
