/**
 * Core types for the Worklog system
 */

export type WorkItemStatus = 'open' | 'in-progress' | 'completed' | 'blocked' | 'deleted';
export type WorkItemPriority = 'low' | 'medium' | 'high' | 'critical';
export type WorkItemRiskLevel = 'Low' | 'Medium' | 'High' | 'Severe';
export type WorkItemEffortLevel = 'XS' | 'S' | 'M' | 'L' | 'XL';

export interface WorkItemAudit {
  time: string;
  author: string;
  text: string;
  /** Optional readiness status derived from the first line of the audit text. */
  status?: 'Complete' | 'Partial' | 'Not Started' | 'Missing Criteria';
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
  audit?: WorkItemAudit;
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
  audit?: WorkItemAudit;
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
  audit?: WorkItemAudit;
}
export interface WorkItemQuery {
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  parentId?: string | null;
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
 * Configuration for a worklog project
 */
export interface WorklogConfig {
  projectName: string;
  prefix: string;
  autoSync?: boolean;
  auditWriteEnabled?: boolean;
  syncRemote?: string;
  syncBranch?: string;
  githubRepo?: string;
  githubLabelPrefix?: string;
  githubImportCreateNew?: boolean;
  // Human display format preference for CLI (concise | normal | full | raw)
  humanDisplay?: 'concise' | 'normal' | 'full' | 'raw';
  statuses?: Array<{ value: string; label: string }>;
  stages?: Array<{ value: string; label: string }>;
  statusStageCompatibility?: Record<string, string[]>;
  // When true, automatically submit a markdown summary to OpenBrain whenever
  // a work item is marked as completed.  Requires the `ob` CLI to be available
  // on PATH (or WL_OB_BIN env var).  Defaults to false.
  openBrainEnabled?: boolean;
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
  chosenSource: 'local' | 'remote' | 'merged';
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
