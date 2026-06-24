// Per-command CLI option interfaces for strong typing
import { WorkItemPriority, WorkItemStatus } from './types.js';

export interface InitOptions {
  projectName?: string;
  prefix?: string;
  autoSync?: string;
  agentsTemplate?: string;
  workflowInline?: string;
  statsPluginOverwrite?: string;
}

export interface StatusOptions { prefix?: string }

export interface CreateOptions {
  title: string;
  description?: string;
  descriptionFile?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  parent?: string;
  tags?: string;
  assignee?: string;
  stage?: string;
  risk?: string;
  effort?: string;
  issueType?: string;
  createdBy?: string;
  deletedBy?: string;
  deleteReason?: string;
  /** Accepts true|false|yes|no to set needsProducerReview flag for the new item */
  needsProducerReview?: string;
  /** Legacy audit flag (kept for compatibility) */
  audit?: string;
  /** Preferred audit flag for structured writes */
  auditText?: string;
  /** Read audit text from a file */
  auditFile?: string;
  prefix?: string;
  /** Skip automatic re-sort after the create action */
  noReSort?: boolean;
  /** Force a synchronous re-sort when run (blocks until complete) */
  reSortSync?: boolean;
}

export interface ListOptions {
  status?: string;
  priority?: WorkItemPriority;
  parent?: string;
  tags?: string;
  assignee?: string;
  stage?: string;
  /** 'true'|'false'|'yes'|'no' (string form from CLI); parsed to boolean by command */
  needsProducerReview?: string | boolean;
  /** Include deleted items in list output when present */
  deleted?: boolean;
  prefix?: string;
  number?: string;
  /** Disable icon rendering for scripting/copy-paste */
  icons?: boolean;
}

export interface ShowOptions { children?: boolean; prefix?: string; noPager?: boolean; icons?: boolean }

export interface AuditOptions { prefix?: string }

export interface UpdateOptions {
  title?: string;
  description?: string;
  descriptionFile?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  parent?: string;
  tags?: string;
  assignee?: string;
  stage?: string;
  /** Accepts true|false|yes|no to set or clear do-not-delegate tag */
  doNotDelegate?: string;
  /** Accepts true|false|yes|no to set needsProducerReview flag */
  needsProducerReview?: string;
  risk?: string;
  effort?: string;
  issueType?: string;
  createdBy?: string;
  deletedBy?: string;
  deleteReason?: string;
  /** Legacy audit flag (kept for compatibility) */
  audit?: string;
  /** Preferred audit flag for structured writes */
  auditText?: string;
  /** Read audit text from a file */
  auditFile?: string;
  prefix?: string;
  /** Skip automatic re-sort after the update action */
  noReSort?: boolean;
  /** Force a synchronous re-sort when run (blocks until complete) */
  reSortSync?: boolean;
}

export interface ExportOptions { file?: string; prefix?: string }
export interface ImportOptions { file?: string; prefix?: string }

export interface NextOptions {
  assignee?: string;
  search?: string;
  number?: string;
  prefix?: string;
  includeBlocked?: boolean;
  /** Skip automatic re-sort before selection */
  noReSort?: boolean;
  /** Force a synchronous re-sort when run (blocks until complete) */
  reSortSync?: boolean;
  /** Recency policy hint for re-sort (prefer|avoid|ignore) */
  recencyPolicy?: string;
}
export interface InProgressOptions { assignee?: string; prefix?: string }

export interface MigrateOptions {
  dryRun?: boolean;
  gap?: string;
  prefix?: string;
  file?: string;
}

export interface ResortOptions {
  dryRun?: boolean;
  gap?: string;
  prefix?: string;
  recency?: string;
}

export interface SyncOptions {
  file?: string;
  prefix?: string;
  gitRemote?: string;
  gitBranch?: string;
  push?: boolean;
  dryRun?: boolean;
  /** Skip automatic re-sort after the sync operation */
  noReSort?: boolean;
  /** Force a synchronous re-sort when run (blocks until complete) */
  reSortSync?: boolean;
}

export interface SyncDebugOptions {
  file?: string;
  prefix?: string;
  gitRemote?: string;
  gitBranch?: string;
}

export interface CommentCreateOptions { author: string; comment?: string; body?: string; references?: string; prefix?: string }
export interface CommentListOptions { prefix?: string }
export interface CommentShowOptions { prefix?: string }
export interface CommentUpdateOptions { author?: string; comment?: string; references?: string; prefix?: string }
export interface CommentDeleteOptions { prefix?: string }

export interface RecentOptions { number?: string; children?: boolean; prefix?: string }
export interface CloseOptions { reason?: string; author?: string; prefix?: string; force?: boolean }

export interface DeleteOptions { prefix?: string; recursive?: boolean; sync?: boolean }

export interface ReviewedOptions { prefix?: string }

export interface DepOptions {
  prefix?: string;
  incoming?: boolean;
  outgoing?: boolean;
}

export interface SearchOptions {
  status?: string;
  priority?: string;
  parent?: string;
  tags?: string;
  assignee?: string;
  stage?: string;
  /** Include deleted items in search results when present */
  deleted?: boolean;
  /** 'true'|'false'|'yes'|'no' (string form from CLI); parsed to boolean by command */
  needsProducerReview?: string | boolean;
  issueType?: string;
  limit?: string;
  rebuildIndex?: boolean;
  semantic?: boolean;
  semanticOnly?: boolean;
  prefix?: string;
}

export interface UnlockOptions { force?: boolean }
