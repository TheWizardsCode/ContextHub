/**
 * Core types for the Worklog system
 */

// Added 'input_needed' to represent items awaiting requester input
export type WorkItemStatus = 'open' | 'in-progress' | 'completed' | 'blocked' | 'deleted' | 'input_needed';
export type WorkItemPriority = 'low' | 'medium' | 'high' | 'critical';
export type WorkItemRiskLevel = 'Low' | 'Medium' | 'High' | 'Severe';
export type WorkItemEffortLevel = 'XS' | 'S' | 'M' | 'L' | 'XL';

/**
 * Structured audit result stored in the audit_results table.
 * This is the sole source of truth for audit state.
 */
export interface AuditResult {
  workItemId: string;
  readyToClose: boolean;
  auditedAt: string;
  summary: string | null;
  rawOutput: string | null;
  author: string | null;
}

/**
 * JSONL dependency edge representation
 */
export interface WorkItemDependency {
  from: string;
  to: string;
}

/**
 * Represents a work item in the system
 */
export interface WorkItem {
  id: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  sortIndex: number;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  assignee: string;
  stage: string;

  // Optional dependency edges (JSONL import/export)
  dependencies?: WorkItemDependency[];

  // Optional metadata for import/interoperability with other issue trackers
  issueType: string;
  createdBy: string;
  deletedBy: string;
  deleteReason: string;

  // Risk and effort estimation (no default)
  risk: WorkItemRiskLevel | '';
  effort: WorkItemEffortLevel | '';

  githubIssueNumber?: number;
  githubIssueId?: number;
  githubIssueUpdatedAt?: string;
  // Indicates whether the item needs a Producer to review/sign-off. Default: false
  needsProducerReview?: boolean;
}

/**
 * Input for creating a new work item
 */
export interface CreateWorkItemInput {
  title: string;
  description?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  sortIndex?: number;
  parentId?: string | null;
  tags?: string[];
  assignee?: string;
  stage?: string;

  issueType?: string;
  createdBy?: string;
  deletedBy?: string;
  deleteReason?: string;

  risk?: WorkItemRiskLevel | '';
  effort?: WorkItemEffortLevel | '';
  /** When present, sets the needsProducerReview flag on the created item */
  needsProducerReview?: boolean;
}

/**
 * Input for updating an existing work item
 */
export interface UpdateWorkItemInput {
  title?: string;
  description?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  sortIndex?: number;
  parentId?: string | null;
  tags?: string[];
  assignee?: string;
  stage?: string;

  issueType?: string;
  createdBy?: string;
  deletedBy?: string;
  deleteReason?: string;

  risk?: WorkItemRiskLevel | '';
  effort?: WorkItemEffortLevel | '';
  /** When present, sets the needsProducerReview flag */
  needsProducerReview?: boolean;
  /**
   * CAS guard (compare-and-swap claim, RCA WL-0MSRBFFLN005W3VT design point 1):
   * when present, the update only applies if the item's CURRENT status matches
   * (normalized hyphenated form). On mismatch the update fails with a `stale`
   * result and no row is written — the losing pane of a concurrent claim race
   * aborts its dispatch instead of double-claiming.
   */
  ifStatus?: WorkItemStatus;
  /**
   * CAS guard: when present, the update only applies if the item's CURRENT
   * stage matches. Composes with `ifStatus` (both must match).
   */
  ifStage?: string;
}
export interface WorkItemQuery {
  status?: WorkItemStatus[];
  priority?: WorkItemPriority;
  parentId?: string | null;
  /** When true, only return root items (items with no parent). Mutually exclusive with parentId. */
  rootOnly?: boolean;
  tags?: string[];
  assignee?: string;
  stage?: string;

  issueType?: string;
  createdBy?: string;
  deletedBy?: string;
  deleteReason?: string;
  // Filter for items that need a Producer review. When present, filters results to items
  // where the `needsProducerReview` flag matches the provided boolean value.
  needsProducerReview?: boolean;
}

/**
 * Configuration for the embedding provider used by semantic search.
 *
 * Fields can be set in `.worklog/config.yaml` under the `embedding` key,
 * or via environment variables as fallbacks. Config values take precedence
 * over environment variables.
 */
export interface EmbeddingConfig {
  /** Provider identifier: 'openai', 'ollama', or a custom base URL hostname */
  provider?: string;
  /** API base URL (default: https://api.openai.com/v1) */
  baseUrl?: string;
  /** Model name (default: text-embedding-3-small) */
  model?: string;
  /** API key (optional — local providers like Ollama don't need one) */
  apiKey?: string;
}

/**
 * Configuration for a worklog project
 */
export interface WorklogConfig {
  projectName: string;
  prefix: string;
  autoSync?: boolean;
  /**
   * Auto-sync interval in seconds for TUI background sync.
   * Controls how often the Pi TUI browse widget triggers a background `wl sync`
   * during auto-refresh.  Set to 0 to disable TUI auto-sync entirely.
   * Default: 10 seconds.
   * This is separate from `autoSync` which controls automatic sync after database writes.
   */
  autoSyncIntervalSeconds?: number;
  auditWriteEnabled?: boolean;
  syncRemote?: string;
  syncBranch?: string;
  /**
   * Force a full (non-incremental) JSONL snapshot after this many consecutive
   * delta syncs (WL-0MT2KY0RQ008F50Q / WL-0MSAKUBKW006FN8Q §5.3).
   * Default 10. The counter is reset whenever a full snapshot is pushed.
   */
  syncFullSnapshotEveryN?: number;
  /**
   * Force a full (non-incremental) JSONL snapshot when the accumulated delta
   * payload exceeds this many bytes (WL-0MT2KY0RQ008F50Q §5.3, advisory
   * threshold). Default 1_000_000 (1 MB).
   */
  syncDeltaSizeThreshold?: number;
  /**
   * Allow `wl sync` to merge commits authored by a different identity than
   * the store's configured `user.email` (identity gate WL-0MSOYWWS4009HTCB).
   * Default false — the sync refuses foreign-author commits. The CLI flag
   * `--allow-foreign-author` takes precedence over this config value.
   * Never bypasses the empty-author-email gate.
   */
  syncAllowForeignAuthor?: boolean;
  githubRepo?: string;
  githubLabelPrefix?: string;
  githubImportCreateNew?: boolean;
  // Human display format preference for CLI (concise | normal | full | raw)
  humanDisplay?: 'concise' | 'normal' | 'full' | 'raw';
  // Whether to enable markdown rendering in CLI output (true | false).
  // When set, this takes precedence over auto-detection but is overridden
  // by explicit command-line flags (CLI > config > auto-detect).
  cliFormatMarkdown?: boolean;
  statuses?: Array<{ value: string; label: string }>;
  stages?: Array<{ value: string; label: string }>;
  statusStageCompatibility?: Record<string, string[]>;
  // When true, automatically submit a markdown summary to OpenBrain whenever
  // a work item is marked as completed.  Requires the `ob` CLI to be available
  // on PATH (or WL_OB_BIN env var).  Defaults to false.
  openBrainEnabled?: boolean;
  /**
   * Embedding provider configuration for semantic search.
   * When set in config, the embedder is considered available even without
   * environment variables — useful for local providers like Ollama.
   *
   * Example:
   * ```yaml
   * embedding:
   *   provider: ollama
   *   baseUrl: http://localhost:11434/v1
   *   model: nomic-embed-text
   * ```
   */
  embedding?: EmbeddingConfig;
}

/**
 * Represents a comment on a work item
 */
export interface Comment {
  id: string;
  workItemId: string;
  author: string;
  comment: string;
  createdAt: string;
  references: string[];
  // Optional GitHub mapping: ID of the GitHub issue comment and last-updated timestamp
  githubCommentId?: number;
  githubCommentUpdatedAt?: string;
}

/**
 * Represents a dependency edge between work items
 * fromId depends on toId
 */
export interface DependencyEdge {
  fromId: string;
  toId: string;
  createdAt: string;
}

/**
 * Input for creating a new comment
 */
export interface CreateCommentInput {
  workItemId: string;
  author: string;
  comment: string;
  references?: string[];
  githubCommentId?: number;
  githubCommentUpdatedAt?: string;
}

/**
 * Input for updating an existing comment
 */
export interface UpdateCommentInput {
  author?: string;
  comment?: string;
  references?: string[];
  githubCommentId?: number | null;
  githubCommentUpdatedAt?: string | null;
}

/**
 * Details about a conflicting field in a work item
 */
export interface ConflictFieldDetail {
  field: string;
  localValue: any;
  remoteValue: any;
  chosenValue: any;
  chosenSource: 'local' | 'remote' | 'merged' | 'both';
  reason: string;
}

/**
 * Details about a conflict that occurred during sync
 */
export interface ConflictDetail {
  itemId: string;
  conflictType: 'same-timestamp' | 'different-timestamp';
  fields: ConflictFieldDetail[];
  localUpdatedAt?: string;
  remoteUpdatedAt?: string;
}

/**
 * Result of finding the next work item with selection reason
 */
export interface NextWorkItemResult {
  workItem: WorkItem | null;
  reason: string;
}

/**
 * JSON output shape for the `show` command when --json mode is enabled.
 * This keeps the CLI's JSON API stable and explicitly documents the fields
 * returned by the endpoint.
 */
export interface ShowJsonOutput {
  success: true | false;
  workItem?: WorkItem;
  comments?: Comment[];
  children?: WorkItem[];
  ancestors?: WorkItem[];
  // Optional error message used when success is false
  error?: string;
}

/**
 * Result of demoting a parent work item after a child was added to it.
 *
 * A parent cannot stay `completed` (status) or `in_review` (stage) while it
 * has uncompleted children, so adding a child to such a parent reopens it.
 * This shape captures the lifecycle transition so callers can report it
 * (e.g. `completed`/`in_review` → `open`/`plan_complete`).
 */
export interface DemotedParent {
  /** The parent work item after the demotion */
  parent: WorkItem;
  /** The parent's status/stage before the demotion */
  from: { status: string; stage: string };
  /** The parent's status/stage after the demotion */
  to: { status: string; stage: string };
}

/**
 * Result of reverting an item whose audit verdict is "not ready to close".
 *
 * When an `in_review` item (status `completed`) receives a not-ready-to-close
 * audit verdict, it is moved back to `open`/`plan_complete` so it returns to
 * the planning queue instead of being swept up by heartbeat/release tooling.
 * This shape captures the lifecycle transition so callers can report it
 * (e.g. `completed`/`in_review` → `open`/`plan_complete`).
 */
export interface RevertedItem {
  /** The work item after the reversion */
  item: WorkItem;
  /** The item's status/stage before the reversion */
  from: { status: string; stage: string };
  /** The item's status/stage after the reversion */
  to: { status: string; stage: string };
}
