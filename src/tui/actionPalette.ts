// Action Palette for Pi TUI
// Provides a keyboard-first action palette for invoking agent-driven flows
// that map to wl CLI commands.

import { EventEmitter } from "events";
import { runWl, wlEvents } from "./wl-integration.js";
import { ChatPane } from "./chatPane.js";

/**
 * An action that can be triggered from the palette.
 */
export interface Action {
  /** Unique action ID */
  id: string;
  /** Display label shown in the palette */
  label: string;
  /** Short description shown below the label */
  description: string;
  /** Keyboard shortcut hint (e.g. "Ctrl+L") */
  shortcut?: string;
  /**
   * Execute the action. May return a result string or Promise<string>.
   * Return null/undefined to indicate no output.
   */
  execute: () => Promise<string | void> | string | void;
  /** Whether this action requires confirmation before execution */
  requiresConfirmation?: boolean;
  /** Category for grouping/filtering (e.g. "Work Items", "Navigation", "System") */
  category?: string;
}

/**
 * ActionPalette provides a keyboard-first palette UI for invoking
 * agent-driven flows that map to wl CLI commands.
 */
export class ActionPalette {
  private actions: Map<string, Action> = new Map();
  private eventEmitter: EventEmitter;
  private selectedIndex = -1;
  private filteredActions: Action[] = [];
  private filterText = "";
  private isOpen = false;

  constructor(
    private chatPane: ChatPane,
    options: { initialActions?: Action[] } = {}
  ) {
    this.eventEmitter = new EventEmitter();
    // Register default actions
    this.registerDefaultActions();
    if (options.initialActions) {
      for (const action of options.initialActions) {
        this.registerAction(action);
      }
    }
  }

  /**
   * Register an action in the palette.
   */
  registerAction(action: Action): void {
    this.actions.set(action.id, action);
    this.applyFilter();
  }

  /**
   * Unregister an action from the palette.
   */
  unregisterAction(id: string): void {
    this.actions.delete(id);
    this.applyFilter();
  }

  /**
   * Get all registered action IDs.
   */
  getActionIds(): string[] {
    return Array.from(this.actions.keys());
  }

  /**
   * Get an action by ID.
   */
  getAction(id: string): Action | undefined {
    return this.actions.get(id);
  }

  /**
   * Get all actions matching the current filter.
   */
  getFilteredActions(): Action[] {
    return this.filteredActions;
  }

  /**
   * Open the action palette and apply the current filter.
   */
  open(): void {
    this.isOpen = true;
    this.selectedIndex = -1;
    this.applyFilter();
    this.emit("palette-open", { actions: this.filteredActions });
  }

  /**
   * Close the action palette.
   */
  close(): void {
    this.isOpen = false;
    this.selectedIndex = -1;
    this.emit("palette-close", {});
  }

  /**
   * Check if the palette is open.
   */
  isOpened(): boolean {
    return this.isOpen;
  }

  /**
   * Set the filter text and re-apply the filter.
   */
  setFilter(text: string): void {
    this.filterText = text.toLowerCase().trim();
    this.selectedIndex = -1;
    this.applyFilter();
  }

  /**
   * Move selection up by one.
   */
  selectPrev(): void {
    if (this.filteredActions.length === 0) return;
    this.selectedIndex =
      this.selectedIndex <= 0
        ? this.filteredActions.length - 1
        : this.selectedIndex - 1;
    this.emit("selection-change", { index: this.selectedIndex, action: this.filteredActions[this.selectedIndex] });
  }

  /**
   * Move selection down by one.
   */
  selectNext(): void {
    if (this.filteredActions.length === 0) return;
    this.selectedIndex =
      this.selectedIndex >= this.filteredActions.length - 1 ? 0 : this.selectedIndex + 1;
    this.emit("selection-change", { index: this.selectedIndex, action: this.filteredActions[this.selectedIndex] });
  }

  /**
   * Execute the currently selected action.
   */
  async executeSelected(): Promise<string | void> {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.filteredActions.length) {
      return;
    }
    const action = this.filteredActions[this.selectedIndex];
    if (action.requiresConfirmation) {
      this.emit("confirm-action", { action });
      return;
    }
    return this.executeAction(action);
  }

  /**
   * Execute a specific action by ID.
   */
  async executeAction(action: Action): Promise<string | void> {
    const result = await action.execute();
    this.emit("action-executed", { action, result });
    return result;
  }

  /**
   * Subscribe to palette events.
   * Events: "palette-open", "palette-close", "selection-change",
   *         "confirm-action", "action-executed", "error"
   */
  on(event: string, listener: (data: any) => void): void {
    this.eventEmitter.on(event, listener);
  }

  /**
   * Remove a palette event listener.
   */
  off(event: string, listener: (data: any) => void): void {
    this.eventEmitter.off(event, listener);
  }

  /**
   * Emit an event to subscribers.
   */
  private emit(event: string, data: unknown): void {
    this.eventEmitter.emit(event, data);
  }

  /**
   * Apply the current filter text to the actions.
   */
  private applyFilter(): void {
    if (!this.filterText) {
      this.filteredActions = Array.from(this.actions.values());
      return;
    }
    this.filteredActions = Array.from(this.actions.values()).filter(
      (a) =>
        a.id.toLowerCase().includes(this.filterText) ||
        a.label.toLowerCase().includes(this.filterText) ||
        a.description.toLowerCase().includes(this.filterText) ||
        (a.category && a.category.toLowerCase().includes(this.filterText))
    );
  }

  /**
   * Register all default actions that map to wl CLI commands.
   */
  private registerDefaultActions(): void {
    // --- Navigation ---
    this.registerAction({
      id: "wl-next",
      label: "Next Task",
      description: "Show the recommended next task",
      shortcut: "Ctrl+N",
      category: "Navigation",
      execute: async () => {
        try {
          const item = await runWl("next");
          if (item && typeof item === "object" && "id" in item) {
            const id = (item as any).id;
            const title = (item as any).title || "Untitled";
            const status = (item as any).status || "unknown";
            return `Suggested next: ${id}: ${title} [${status}]`;
          }
          return "No next task recommended.";
        } catch (err) {
          throw new Error(`wl next failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    this.registerAction({
      id: "wl-list",
      label: "List Work Items",
      description: "Show the first 10 work items",
      shortcut: "Ctrl+L",
      category: "Navigation",
      execute: async () => {
        try {
          const items = await runWl("list", ["-n", "10"]);
          if (Array.isArray(items) && items.length > 0) {
            return items.map((i: any) => `  ${i.id}: ${i.title} [${i.status}]`).join("\n");
          }
          return "No work items found.";
        } catch (err) {
          throw new Error(`wl list failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    // --- Work Item Actions ---
    this.registerAction({
      id: "wl-create",
      label: "Create Work Item",
      description: "Create a new work item via chat",
      shortcut: "Ctrl+C",
      category: "Work Items",
      execute: async () => {
        const description = "New work item";
        try {
          const result = await runWl("create", ["-t", description, "--description", description]);
          if (result && typeof result === "object") {
            return `Created: ${(result as any).id}`;
          }
          return "Work item created.";
        } catch (err) {
          throw new Error(`wl create failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      requiresConfirmation: true,
    });

    this.registerAction({
      id: "wl-close",
      label: "Close Work Item",
      description: "Close a work item by ID",
      shortcut: "Ctrl+Shift+C",
      category: "Work Items",
      execute: async () => {
        const id = promptInput("Enter work item ID to close:");
        if (!id) return "Cancelled.";
        try {
          const result = await runWl("close", [id]);
          if (result && typeof result === "object") {
            return `Closed: ${id}`;
          }
          return `Closed: ${id}`;
        } catch (err) {
          throw new Error(`wl close failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      requiresConfirmation: true,
    });

    this.registerAction({
      id: "wl-update",
      label: "Update Work Item",
      description: "Update a work item's description",
      shortcut: "Ctrl+E",
      category: "Work Items",
      execute: async () => {
        const id = promptInput("Enter work item ID to update:");
        if (!id) return "Cancelled.";
        const desc = promptInput("Enter new description:");
        if (!desc) return "Cancelled.";
        try {
          await runWl("update", [id, "--description", desc]);
          return `Updated: ${id}`;
        } catch (err) {
          throw new Error(`wl update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      requiresConfirmation: true,
    });

    this.registerAction({
      id: "wl-show",
      label: "Show Work Item",
      description: "Show details of a specific work item",
      shortcut: "Ctrl+S",
      category: "Navigation",
      execute: async () => {
        const id = promptInput("Enter work item ID to show:");
        if (!id) return "Cancelled.";
        try {
          const item = await runWl("show", [id]);
          if (item && typeof item === "object") {
            return formatWorkItemDisplay(item as any);
          }
          return `Work item ${id} not found.`;
        } catch (err) {
          throw new Error(`wl show failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    this.registerAction({
      id: "wl-search",
      label: "Search Work Items",
      description: "Search for work items by keyword",
      shortcut: "Ctrl+F",
      category: "Navigation",
      execute: async () => {
        const query = promptInput("Enter search query:");
        if (!query) return "Cancelled.";
        try {
          const items = await runWl("search", [query]);
          if (Array.isArray(items) && items.length > 0) {
            return items.map((i: any) => `  ${i.id}: ${i.title} [${i.status}]`).join("\n");
          }
          return `No results for "${query}".`;
        } catch (err) {
          throw new Error(`wl search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    // --- Chat ---
    this.registerAction({
      id: "chat",
      label: "Start Agent Conversation",
      description: "Open the chat pane for freeform agent interaction",
      shortcut: "Ctrl+/",
      category: "Agent",
      execute: async () => {
        return "Chat pane opened. Type your request in the chat input.";
      },
    });

    // --- Agent Flows ---
    this.registerAction({
      id: "agent-claim",
      label: "Claim Next Task",
      description: "Automatically claim the next recommended task",
      shortcut: "Ctrl+Shift+L",
      category: "Agent",
      execute: async () => {
        try {
          const next = await runWl("next");
          if (next && typeof next === "object" && "id" in next) {
            const id = (next as any).id;
            await runWl("update", [id, "--assignee", "OpenAI-Agent"]);
            return `Claimed: ${id}`;
          }
          return "No tasks available to claim.";
        } catch (err) {
          throw new Error(`Claim failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      requiresConfirmation: true,
    });

    this.registerAction({
      id: "agent-comment",
      label: "Add Comment",
      description: "Add a comment to a work item",
      shortcut: "Ctrl+M",
      category: "Agent",
      execute: async () => {
        const id = promptInput("Enter work item ID:");
        if (!id) return "Cancelled.";
        const content = promptInput("Enter comment text:");
        if (!content) return "Cancelled.";
        try {
          await runWl("comment", ["add", id, "--comment", content]);
          return `Comment added to ${id}.`;
        } catch (err) {
          throw new Error(`Comment failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      requiresConfirmation: true,
    });

    this.registerAction({
      id: "agent-status",
      label: "Change Status",
      description: "Change the status of a work item",
      shortcut: "Ctrl+T",
      category: "Agent",
      execute: async () => {
        const id = promptInput("Enter work item ID:");
        if (!id) return "Cancelled.";
        const status = promptInput("Enter new status (open/in-progress/closed):");
        if (!status) return "Cancelled.";
        try {
          await runWl("update", [id, "--status", status]);
          return `Updated status to ${status} for ${id}.`;
        } catch (err) {
          throw new Error(`Status change failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      requiresConfirmation: true,
    });
  }
}

/**
 * Prompt for input via the console.
 * In a full TUI implementation, this would use the TUI input component.
 */
function promptInput(promptText: string): string {
  // For headless/CI testing, return empty to cancel
  // In a real TUI, this would show a modal input
  return "";
}

/**
 * Format a work item for display.
 */
function formatWorkItemDisplay(item: any): string {
  const lines = [
    `${item.id}: ${item.title}`,
    `Status: ${item.status || "unknown"}`,
    `Priority: ${item.priority || "medium"}`,
    `Type: ${item.issueType || "task"}`,
    `Stage: ${item.stage || "unknown"}`,
    `Assignee: ${item.assignee || "unassigned"}`,
  ];
  if (item.description) {
    const desc = item.description.substring(0, 200);
    lines.push(`Description: ${desc}`);
  }
  return lines.join("\n");
}
