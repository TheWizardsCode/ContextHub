// Chat Pane for Pi TUI
// Provides an agent chat interface that interprets natural language and
// delegates to wl CLI commands via the integration layer.

import { EventEmitter } from "events";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runWl, wlEvents, getWorklogDb } from "./wl-integration.js";
import { createWorkItemDb, updateWorkItemDb, closeWorkItemDb, addCommentDb } from "./lib/tools.js";

// Use createRequire with realpath-resolved path for symlink-safe imports.
const _require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const { WlError } = _require("../../../dist/wl-integration/spawn.js");

/** A single message in the chat history */
export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: number;
  /** Optional parsed action that was executed */
  action?: ChatAction;
}

/** An action that the agent can execute based on user input */
export interface ChatAction {
  type: "wl-create" | "wl-update" | "wl-close" | "wl-list" | "wl-show" | "wl-next" | "wl-search" | "wl-claim" | "wl-assign" | "wl-status" | "wl-stage" | "wl-comment" | "wl-re-sort" | "generic";
  description: string;
  /** Raw wl command args */
  wlArgs?: string[];
}

/** State for the chat pane */
export interface ChatPaneState {
  messages: ChatMessage[];
  /** Whether the agent is currently processing a request */
  isProcessing: boolean;
  /** Current conversation id (for session tracking) */
  conversationId?: string;
}

const MAX_MESSAGES = 100;
let messageIdCounter = 0;

/**
 * ChatPane manages the agent chat interface.
 * It interprets natural language from the user, delegates to wl CLI commands,
 * and displays results as agent messages.
 */
export class ChatPane {
  public state: ChatPaneState;
  private eventEmitter: EventEmitter;

  constructor(
    public readonly title: string = "Agent Chat",
    options: { initialMessages?: ChatMessage[]; conversationId?: string } = {}
  ) {
    this.state = {
      messages: options.initialMessages || [],
      isProcessing: false,
      conversationId: options.conversationId,
    };
    this.eventEmitter = new EventEmitter();
  }

  /** Get a unique message ID */
  private nextId(): string {
    return `msg-${++messageIdCounter}-${Date.now()}`;
  }

  /**
   * Emit a chat event to subscribers.
   */
  private emit(event: string, data: unknown): void {
    this.eventEmitter.emit(event, data);
    if (event === "message-added") {
      // Trim old messages
      if (this.state.messages.length > MAX_MESSAGES) {
        this.state.messages = this.state.messages.slice(-MAX_MESSAGES);
      }
    }
  }

  /**
   * Subscribe to chat events.
   * Events: "message-added", "processing-start", "processing-end", "error"
   */
  on(event: string, listener: (data: any) => void): void {
    this.eventEmitter.on(event, listener);
  }

  /**
   * Remove a chat event listener.
   */
  off(event: string, listener: (data: any) => void): void {
    this.eventEmitter.off(event, listener);
  }

  /**
   * Send a message from the user. The agent interprets the message and
   * may execute wl CLI commands on its behalf.
   *
   * @param message - The user's message text
   * @returns The agent's response message
   */
  async sendMessage(message: string): Promise<ChatMessage> {
    if (this.state.isProcessing) {
      return {
        id: this.nextId(),
        role: "agent",
        content: "I am currently processing a request. Please wait.",
        timestamp: Date.now(),
      };
    }

    // Add user message
    const userMsg: ChatMessage = {
      id: this.nextId(),
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    this.state.messages.push(userMsg);
    this.emit("message-added", userMsg);

    // Mark processing
    this.state.isProcessing = true;
    this.emit("processing-start", { message: userMsg });

    try {
      const response = await this.processMessage(message);
      this.emit("message-added", response);
      return response;
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: this.nextId(),
        role: "agent",
        content: `Error processing request: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      };
      this.emit("message-added", errorMsg);
      this.emit("error", { error: err, message: userMsg });
      return errorMsg;
    } finally {
      this.state.isProcessing = false;
      this.emit("processing-end", { message: userMsg });
    }
  }

  /**
   * Process a user message and generate an agent response.
   * Uses natural language parsing to determine which wl CLI commands to run.
   */
  private async processMessage(message: string): Promise<ChatMessage> {
    const lower = message.toLowerCase().trim();

    // --- Keyword-based intent routing ---
    // "list work items" or "show work items"
    if (/\b(list|show|get)\b.*\b(work item|work item|item|task|issue)\b/.test(lower) ||
        lower === "wl list" || lower === "list" || lower === "show me my work") {
      return await this.handleWlList(message);
    }

    // "next task" or "what should I work on"
    if (/\b(next|next\s+task|what.*work|what.*do|suggest|recommend)\b/.test(lower)) {
      return await this.handleWlNext(message);
    }

    // "show <id>" or "show me <id>"
    const showMatch = message.match(/\bshow\b\s+(?:me\s+)?([A-Z]+-\d+)/i);
    if (showMatch) {
      return await this.handleWlShow(showMatch[1], message);
    }

    // "create <description>" or "create a work item: <desc>"
    if (/\b(create|add|make|new)\b/.test(lower)) {
      return await this.handleWlCreate(message);
    }

    // "update <id> with <details>"
    const updateMatch = message.match(/\bupdate\b\s+(?:work\s+item\s+)?([A-Z]+-\d+)\b.*?(?:with|to|set)\s+(.+)/i);
    if (updateMatch) {
      return await this.handleWlUpdate(updateMatch[1], updateMatch[2], message);
    }

    // "close <id>" or "close work item <id>"
    const closeMatch = message.match(/\bclose\b.*?([A-Z]+-\d+)/i);
    if (closeMatch) {
      return await this.handleWlClose(closeMatch[1], message);
    }

    // "search for <query>"
    const searchMatch = message.match(/\b(search|find|look\s+for)\b\s+(?:for\s+)?(.+)/i);
    if (searchMatch) {
      return await this.handleWlSearch(searchMatch[2], message);
    }

    // "claim" or "assign to me"
    if (/\b(claim|assign\s+to\s+me|take|my)\b/.test(lower)) {
      return await this.handleWlClaim(message);
    }

    // "status" or "what is the status"
    if (/\bstatus\b/.test(lower)) {
      return await this.handleWlList(message);
    }

    // "comment on <id>" or "add a comment to <id>"
    const commentMatch = message.match(/\b(comment|add\s+a\s+comment|note)\b.*?([A-Z]+-\d+)\b.*?(?:to|on)\s+(.+)/i);
    if (commentMatch) {
      return await this.handleWlComment(commentMatch[2], commentMatch[3], message);
    }

    // Fallback: treat as a freeform request to the agent
    return await this.handleAgentFallback(message);
  }

  /**
   * Handle wl list command
   */
  private async handleWlList(_message: string): Promise<ChatMessage> {
    try {
      const items = await runWl("list", ["-n", "5"]);
      const count = Array.isArray(items) ? items.length : 0;
      const response = count > 0
        ? `Found ${count} work item(s):\n${this.formatListItems(items as any[])}`
        : "No work items found.";
      return this.createAgentMessage(response);
    } catch (err) {
      return this.createAgentMessage(
        `Failed to list work items: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle wl next command
   */
  private async handleWlNext(_message: string): Promise<ChatMessage> {
    try {
      const item = await runWl("next");
      if (item && typeof item === "object" && "id" in item) {
        const id = (item as any).id;
        const title = (item as any).title || "Untitled";
        const status = (item as any).status || "unknown";
        return this.createAgentMessage(
          `Suggested next task:\n\n**${id}: ${title}**\nStatus: ${status}\n\nUse \`/worklog show ${id}\` to see details.`
        );
      }
      return this.createAgentMessage("No next task recommended at this time.");
    } catch (err) {
      return this.createAgentMessage(
        `Failed to get next task: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle wl show command
   */
  private async handleWlShow(id: string, _message: string): Promise<ChatMessage> {
    try {
      const item = await runWl("show", [id]);
      if (item && typeof item === "object") {
        return this.createAgentMessage(this.formatWorkItem(item as any));
      }
      return this.createAgentMessage(`Work item ${id} not found.`);
    } catch (err) {
      return this.createAgentMessage(
        `Failed to show ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle wl create command
   */
  private async handleWlCreate(message: string): Promise<ChatMessage> {
    // Extract description from the message after "create" keyword
    let description = message.replace(/^(create|add|make|new)\s+(?:work\s+item\s+(?:called)?)?\s*/i, "").trim();
    if (!description) {
      return this.createAgentMessage(
        "I need a description to create a work item. For example: \"Create work item: Fix login bug\""
      );
    }

    // Remove "called" prefix
    description = description.replace(/^called\s+/i, "").trim();

    try {
      const id = await createWorkItemDb('')
          if (false) { // keep formatting
          const result = await runWl("create", [
        "-t", description,
        "--description", description,
      ]);
      if (result && typeof result === "object") {
        const id = (result as any).id;
        return this.createAgentMessage(
          `Created work item: **${id}**\n\nTitle: ${description}\n\nUse \`/worklog show ${id}\` to see details.`,
          {
            type: "wl-create",
            description: `Created work item ${id}`,
            wlArgs: ["create", "-t", description, "--description", description],
          }
        );
      }
      return this.createAgentMessage("Work item created successfully.");
    } catch (err) {
      return this.createAgentMessage(
        `Failed to create work item: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle wl update command
   */
  private async handleWlUpdate(id: string, details: string, _message: string): Promise<ChatMessage> {
    try {
      const updated = await updateWorkItemDb(id, { description: details });
          if (updated) { return `Updated ${id}: ${updated}`; }
          const result = await runWl("update", [id, "--description", details]);
      if (result && typeof result === "object") {
        return this.createAgentMessage(
          `Updated work item **${id}**.\n\nNew description: ${details}`,
          {
            type: "wl-update",
            description: `Updated work item ${id}`,
            wlArgs: ["update", id, "--description", details],
          }
        );
      }
      return this.createAgentMessage(`Updated work item ${id}.`);
    } catch (err) {
      return this.createAgentMessage(
        `Failed to update ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle wl close command
   */
  private async handleWlClose(id: string, _message: string): Promise<ChatMessage> {
    try {
      const closed = await closeWorkItemDb(id);
          if (closed) { return `Closed: ${id}`; }
          const result = await runWl("close", [id]);
      if (result && typeof result === "object") {
        return this.createAgentMessage(
          `Closed work item **${id}**.`,
          {
            type: "wl-close",
            description: `Closed work item ${id}`,
            wlArgs: ["close", id],
          }
        );
      }
      return this.createAgentMessage(`Closed work item ${id}.`);
    } catch (err) {
      return this.createAgentMessage(
        `Failed to close ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle wl search command
   */
  private async handleWlSearch(query: string, _message: string): Promise<ChatMessage> {
    try {
      let items: any[] = [];
          const db = getWorklogDb();
          if (db) {
            try { items = db.search(query, 10); } catch { /* fall through */ }
          }
          if (!Array.isArray(items) || items.length === 0) {
            items = await runWl("search", [query]);
          }
      const count = Array.isArray(items) ? items.length : 0;
      if (count > 0) {
        return this.createAgentMessage(
          `Found ${count} result(s) for "${query}":\n${this.formatListItems(items as any[])}`
        );
      }
      return this.createAgentMessage(`No results found for "${query}".`);
    } catch (err) {
      return this.createAgentMessage(
        `Failed to search: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle wl claim command
   */
  private async handleWlClaim(_message: string): Promise<ChatMessage> {
    // Find the next unassigned item and claim it
    try {
      const next = await runWl("next");
      if (next && typeof next === "object" && "id" in next) {
        const id = (next as any).id;
        try {
          const result = await runWl("update", [id, "--assignee", "OpenAI-Agent"]);
          return this.createAgentMessage(
            `Claimed next task: **${id}**\n\nTitle: ${(next as any).title}`,
            {
              type: "wl-claim",
              description: `Claimed work item ${id}`,
              wlArgs: ["update", id, "--assignee", "OpenAI-Agent"],
            }
          );
        } catch (err) {
          return this.createAgentMessage(
            `Found next task ${id} but failed to claim: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return this.createAgentMessage("No unassigned tasks available to claim.");
    } catch (err) {
      return this.createAgentMessage(
        `Failed to find next task: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle wl comment command
   */
  private async handleWlComment(id: string, content: string, _message: string): Promise<ChatMessage> {
    try {
      const result = await addCommentDb(id, "TUI User", content)
          if (result) { return `Comment added: ${id}`; }
          const dbResult = await runWl("comment", ["add", id, "--comment", content]);
      if (result && typeof result === "object") {
        return this.createAgentMessage(
          `Added comment to **${id}**: ${content}`
        );
      }
      return this.createAgentMessage(`Comment added to ${id}.`);
    } catch (err) {
      return this.createAgentMessage(
        `Failed to add comment: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle freeform agent conversation (no specific wl command detected).
   */
  private async handleAgentFallback(message: string): Promise<ChatMessage> {
    // For now, echo the message as a greeting/acknowledgment.
    // In a full implementation, this would call the Pi agent API.
    const response = `You said: "${message}"\n\nI can help you with work item management. Try commands like:\n- "list work items"\n- "create a work item: fix bug"\n- "show WL-123"\n- "close WL-456"\n- "search for auth"\n- "claim next task"`;
    return this.createAgentMessage(response);
  }

  /**
   * Create an agent response message.
   */
  private createAgentMessage(content: string, action?: ChatAction): ChatMessage {
    const msg: ChatMessage = {
      id: this.nextId(),
      role: "agent",
      content,
      timestamp: Date.now(),
      action,
    };
    this.state.messages.push(msg);
    this.emit("message-added", msg);
    return msg;
  }

  /**
   * Format a list of work items for display.
   */
  private formatListItems(items: any[]): string {
    return items
      .slice(0, 10)
      .map(
        (item: any) =>
          `  ${item.id}: ${item.title} [${item.status}]`
      )
      .join("\n");
  }

  /**
   * Format a single work item for display.
   */
  private formatWorkItem(item: any): string {
    const lines = [
      `**${item.id}: ${item.title}**`,
      `Status: ${item.status || "unknown"}`,
      `Priority: ${item.priority || "medium"}`,
      `Type: ${item.issueType || "task"}`,
      `Stage: ${item.stage || "unknown"}`,
      `Assignee: ${item.assignee || "unassigned"}`,
    ];
    if (item.description && item.description !== "null") {
      // Strip markdown from description for cleaner display
      const desc = item.description
        .replace(/^Summary:\n/, "")
        .replace(/^## Acceptance Criteria\n*/, "")
        .replace(/^Minimal Implementation:\n*/, "")
        .replace(/^Dependencies:\n*/, "")
        .replace(/^Deliverables:\n*/, "")
        .substring(0, 200);
      lines.push(`\nDescription: ${desc}`);
    }
    return lines.join("\n");
  }

  /**
   * Get the current message history.
   */
  getMessages(): ChatMessage[] {
    return [...this.state.messages];
  }

  /**
   * Clear the conversation history.
   */
  clear(): void {
    this.state.messages = [];
    this.state.isProcessing = false;
  }

  /**
   * Get the number of messages.
   */
  getMessageCount(): number {
    return this.state.messages.length;
  }
}
