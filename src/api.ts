/**
 * REST API for the Worklog system
 */

import express, { Request, Response, NextFunction } from 'express';
import { WorklogDatabase } from './database.js';
import { CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery, WorkItemStatus, WorkItemPriority, CreateCommentInput, UpdateCommentInput } from './types.js';
import { exportToJsonl, importFromJsonl, getDefaultDataPath } from './jsonl.js';
import { loadConfig } from './config.js';
import { buildAuditEntry, hasAcceptanceCriteria } from './audit.js';

function parseNeedsProducerReview(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).toLowerCase();
  if (['true', 'yes', '1'].includes(raw)) return true;
  if (['false', 'no', '0'].includes(raw)) return false;
  return undefined;
}

function normalizeCreateInputWithAudit(input: CreateWorkItemInput): CreateWorkItemInput {
  const rawAudit = (input as any).audit;
  if (typeof rawAudit === 'string') {
    return {
      ...input,
      audit: buildAuditEntry(rawAudit, undefined, { hasAcceptanceCriteria: hasAcceptanceCriteria(input.description) }),
    };
  }
  return input;
}

function normalizeUpdateInputWithAudit(input: UpdateWorkItemInput): UpdateWorkItemInput {
  const rawAudit = (input as any).audit;
  if (typeof rawAudit === 'string') {
    return {
      ...input,
      // We cannot reliably determine acceptance criteria here because the
      // caller may be updating description simultaneously. For simplicity
      // assume the provided body includes the same description as current
      // stored item; the API layer does not have the current item here, so
      // we conservatively set hasAcceptanceCriteria to true when the
      // incoming request includes a description that looks like it has criteria.
      audit: buildAuditEntry(rawAudit, undefined, { hasAcceptanceCriteria: hasAcceptanceCriteria((input as any).description) }),
    };
  }
  return input;
}

function hasAuditField(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(input as object, 'audit') && (input as any).audit !== undefined;
}

export function createAPI(db: WorklogDatabase) {
  const app = express();
  app.use(express.json());

  // Load configuration to get default prefix
  const config = loadConfig();
  const defaultPrefix = config?.prefix || 'WI';
  const auditWriteEnabled = config?.auditWriteEnabled !== false;

  // Middleware to set the database prefix based on the route
  function setPrefixMiddleware(req: Request, res: Response, next: NextFunction) {
    const prefix = req.params.prefix || defaultPrefix;
    db.setPrefix(prefix.toUpperCase());
    next();
  }

  // Health check
  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', prefix: defaultPrefix });
  });

  // Routes without prefix (for backward compatibility)
  // Create a work item
  app.post('/items', (req: Request, res: Response) => {
    try {
      db.setPrefix(defaultPrefix);
      if (!auditWriteEnabled && hasAuditField(req.body)) {
        res.status(400).json({ error: 'Audit writes are disabled by config (auditWriteEnabled: false)' });
        return;
      }
      const input: CreateWorkItemInput = normalizeCreateInputWithAudit(req.body);
      const item = db.create(input);
      res.status(201).json(item);
    } catch (error) {
      const message = (error as Error).message || 'Invalid request';
      res.status(400).json({ error: message });
    }
  });

  // Get a work item by ID
  app.get('/items/:id', (req: Request, res: Response) => {
    db.setPrefix(defaultPrefix);
    const item = db.get(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Work item not found' });
      return;
    }
    res.json(item);
  });

  // Update a work item
  app.put('/items/:id', (req: Request, res: Response) => {
    try {
      db.setPrefix(defaultPrefix);
      if (!auditWriteEnabled && hasAuditField(req.body)) {
        res.status(400).json({ error: 'Audit writes are disabled by config (auditWriteEnabled: false)' });
        return;
      }
      const current = db.get(req.params.id);
      if (!current) {
        res.status(404).json({ error: 'Work item not found' });
        return;
      }
      // If the caller provided a string `audit`, build the structured audit entry
      // using information from the stored item when the request does not include
      // a description. This ensures the hasAcceptanceCriteria signal is derived
      // from the correct source (incoming description when present, otherwise
      // the current stored description).
      let normalizedBody: any = req.body;
      const rawAudit = (req.body as any).audit;
      if (typeof rawAudit === 'string') {
        const descriptionCandidate = Object.prototype.hasOwnProperty.call(req.body, 'description') ? (req.body as any).description : current.description;
        normalizedBody = {
          ...req.body,
          audit: buildAuditEntry(rawAudit, undefined, { hasAcceptanceCriteria: hasAcceptanceCriteria(descriptionCandidate) }),
        };
      }
      const input: UpdateWorkItemInput = normalizeUpdateInputWithAudit(normalizedBody);
      const item = db.update(req.params.id, input);
      if (!item) {
        res.status(404).json({ error: 'Work item not found' });
        return;
      }
      res.json(item);
    } catch (error) {
      const message = (error as Error).message || 'Invalid request';
      res.status(400).json({ error: message });
    }
  });

  // Delete a work item
  app.delete('/items/:id', (req: Request, res: Response) => {
    db.setPrefix(defaultPrefix);
    const deleted = db.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Work item not found' });
      return;
    }
    res.status(204).send();
  });

  // List work items with optional filters
  app.get('/items', (req: Request, res: Response) => {
    db.setPrefix(defaultPrefix);
    const query: WorkItemQuery = {};
    
    if (req.query.status) {
      query.status = req.query.status as WorkItemStatus;
    }
    if (req.query.priority) {
      query.priority = req.query.priority as WorkItemPriority;
    }
    if (req.query.parentId !== undefined) {
      query.parentId = req.query.parentId === 'null' ? null : req.query.parentId as string;
    }
    if (req.query.tags) {
      query.tags = Array.isArray(req.query.tags) ? req.query.tags as string[] : [req.query.tags as string];
    }
    if (req.query.assignee) {
      query.assignee = req.query.assignee as string;
    }
    if (req.query.stage) {
      query.stage = req.query.stage as string;
    }
    if (req.query.needsProducerReview !== undefined) {
      const parsed = parseNeedsProducerReview(req.query.needsProducerReview);
      if (parsed === undefined) {
        res.status(400).json({ error: 'Invalid needsProducerReview value' });
        return;
      }
      query.needsProducerReview = parsed;
    }

    // Interoperability metadata filters
    if (req.query.issueType) {
      (query as any).issueType = req.query.issueType as string;
    }
    if (req.query.createdBy) {
      (query as any).createdBy = req.query.createdBy as string;
    }
    if (req.query.deletedBy) {
      (query as any).deletedBy = req.query.deletedBy as string;
    }
    if (req.query.deleteReason) {
      (query as any).deleteReason = req.query.deleteReason as string;
    }

    const items = db.list(query);
    res.json(items);
  });

  // Get children of a work item
  app.get('/items/:id/children', (req: Request, res: Response) => {
    db.setPrefix(defaultPrefix);
    const children = db.getChildren(req.params.id);
    res.json(children);
  });

  // Get descendants of a work item
  app.get('/items/:id/descendants', (req: Request, res: Response) => {
    db.setPrefix(defaultPrefix);
    const descendants = db.getDescendants(req.params.id);
    res.json(descendants);
  });

  // Comment routes without prefix
  // Create a comment for a work item
  app.post('/items/:id/comments', (req: Request, res: Response) => {
    try {
      db.setPrefix(defaultPrefix);
      const input: CreateCommentInput = {
        workItemId: req.params.id,
        author: req.body.author,
        comment: req.body.comment,
        references: req.body.references,
      };
      const comment = db.createComment(input);
      if (!comment) {
        res.status(404).json({ error: 'Work item not found' });
        return;
      }
      res.status(201).json(comment);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // Get all comments for a work item
  app.get('/items/:id/comments', (req: Request, res: Response) => {
    db.setPrefix(defaultPrefix);
    const comments = db.getCommentsForWorkItem(req.params.id);
    res.json(comments);
  });

  // Get a specific comment by ID
  app.get('/comments/:commentId', (req: Request, res: Response) => {
    db.setPrefix(defaultPrefix);
    const comment = db.getComment(req.params.commentId);
    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    res.json(comment);
  });

  // Update a comment
  app.put('/comments/:commentId', (req: Request, res: Response) => {
    try {
      db.setPrefix(defaultPrefix);
      const input: UpdateCommentInput = req.body;
      const comment = db.updateComment(req.params.commentId, input);
      if (!comment) {
        res.status(404).json({ error: 'Comment not found' });
        return;
      }
      res.json(comment);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // Delete a comment
  app.delete('/comments/:commentId', (req: Request, res: Response) => {
    db.setPrefix(defaultPrefix);
    const deleted = db.deleteComment(req.params.commentId);
    if (!deleted) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    res.status(204).send();
  });

  // Routes with prefix
  // Create a work item with prefix
  app.post('/projects/:prefix/items', setPrefixMiddleware, (req: Request, res: Response) => {
    try {
      if (!auditWriteEnabled && hasAuditField(req.body)) {
        res.status(400).json({ error: 'Audit writes are disabled by config (auditWriteEnabled: false)' });
        return;
      }
      const input: CreateWorkItemInput = normalizeCreateInputWithAudit(req.body);
      const item = db.create(input);
      res.status(201).json(item);
    } catch (error) {
      const message = (error as Error).message || 'Invalid request';
      res.status(400).json({ error: message });
    }
  });

  // Get a work item by ID with prefix
  app.get('/projects/:prefix/items/:id', setPrefixMiddleware, (req: Request, res: Response) => {
    const item = db.get(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Work item not found' });
      return;
    }
    res.json(item);
  });

  // Update a work item with prefix
  app.put('/projects/:prefix/items/:id', setPrefixMiddleware, (req: Request, res: Response) => {
    try {
      if (!auditWriteEnabled && hasAuditField(req.body)) {
        res.status(400).json({ error: 'Audit writes are disabled by config (auditWriteEnabled: false)' });
        return;
      }
      const current = db.get(req.params.id);
      if (!current) {
        res.status(404).json({ error: 'Work item not found' });
        return;
      }
      // See comment in the non-prefixed update handler — prefer the incoming
      // description when present, otherwise use the stored item's description
      // to determine whether acceptance criteria exist for conservative status
      // resolution.
      let normalizedBody: any = req.body;
      const rawAudit = (req.body as any).audit;
      if (typeof rawAudit === 'string') {
        const descriptionCandidate = Object.prototype.hasOwnProperty.call(req.body, 'description') ? (req.body as any).description : current.description;
        normalizedBody = {
          ...req.body,
          audit: buildAuditEntry(rawAudit, undefined, { hasAcceptanceCriteria: hasAcceptanceCriteria(descriptionCandidate) }),
        };
      }
      const input: UpdateWorkItemInput = normalizeUpdateInputWithAudit(normalizedBody);
      const item = db.update(req.params.id, input);
      if (!item) {
        res.status(404).json({ error: 'Work item not found' });
        return;
      }
      res.json(item);
    } catch (error) {
      const message = (error as Error).message || 'Invalid request';
      res.status(400).json({ error: message });
    }
  });

  // Delete a work item with prefix
  app.delete('/projects/:prefix/items/:id', setPrefixMiddleware, (req: Request, res: Response) => {
    const deleted = db.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Work item not found' });
      return;
    }
    res.status(204).send();
  });

  // List work items with prefix
  app.get('/projects/:prefix/items', setPrefixMiddleware, (req: Request, res: Response) => {
    const query: WorkItemQuery = {};
    
    if (req.query.status) {
      query.status = req.query.status as WorkItemStatus;
    }
    if (req.query.priority) {
      query.priority = req.query.priority as WorkItemPriority;
    }
    if (req.query.parentId !== undefined) {
      query.parentId = req.query.parentId === 'null' ? null : req.query.parentId as string;
    }
    if (req.query.tags) {
      query.tags = Array.isArray(req.query.tags) ? req.query.tags as string[] : [req.query.tags as string];
    }
    if (req.query.assignee) {
      query.assignee = req.query.assignee as string;
    }
    if (req.query.stage) {
      query.stage = req.query.stage as string;
    }
    if (req.query.needsProducerReview !== undefined) {
      const parsed = parseNeedsProducerReview(req.query.needsProducerReview);
      if (parsed === undefined) {
        res.status(400).json({ error: 'Invalid needsProducerReview value' });
        return;
      }
      query.needsProducerReview = parsed;
    }

    // Interoperability metadata filters
    if (req.query.issueType) {
      (query as any).issueType = req.query.issueType as string;
    }
    if (req.query.createdBy) {
      (query as any).createdBy = req.query.createdBy as string;
    }
    if (req.query.deletedBy) {
      (query as any).deletedBy = req.query.deletedBy as string;
    }
    if (req.query.deleteReason) {
      (query as any).deleteReason = req.query.deleteReason as string;
    }

    const items = db.list(query);
    res.json(items);
  });

  // Get children of a work item with prefix
  app.get('/projects/:prefix/items/:id/children', setPrefixMiddleware, (req: Request, res: Response) => {
    const children = db.getChildren(req.params.id);
    res.json(children);
  });

  // Get descendants of a work item with prefix
  app.get('/projects/:prefix/items/:id/descendants', setPrefixMiddleware, (req: Request, res: Response) => {
    const descendants = db.getDescendants(req.params.id);
    res.json(descendants);
  });

  // Comment routes with prefix
  // Create a comment for a work item with prefix
  app.post('/projects/:prefix/items/:id/comments', setPrefixMiddleware, (req: Request, res: Response) => {
    try {
      const input: CreateCommentInput = {
        workItemId: req.params.id,
        author: req.body.author,
        comment: req.body.comment,
        references: req.body.references,
      };
      const comment = db.createComment(input);
      if (!comment) {
        res.status(404).json({ error: 'Work item not found' });
        return;
      }
      res.status(201).json(comment);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // Get all comments for a work item with prefix
  app.get('/projects/:prefix/items/:id/comments', setPrefixMiddleware, (req: Request, res: Response) => {
    const comments = db.getCommentsForWorkItem(req.params.id);
    res.json(comments);
  });

  // Get a specific comment by ID with prefix
  app.get('/projects/:prefix/comments/:commentId', setPrefixMiddleware, (req: Request, res: Response) => {
    const comment = db.getComment(req.params.commentId);
    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    res.json(comment);
  });

  // Update a comment with prefix
  app.put('/projects/:prefix/comments/:commentId', setPrefixMiddleware, (req: Request, res: Response) => {
    try {
      const input: UpdateCommentInput = req.body;
      const comment = db.updateComment(req.params.commentId, input);
      if (!comment) {
        res.status(404).json({ error: 'Comment not found' });
        return;
      }
      res.json(comment);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // Delete a comment with prefix
  app.delete('/projects/:prefix/comments/:commentId', setPrefixMiddleware, (req: Request, res: Response) => {
    const deleted = db.deleteComment(req.params.commentId);
    if (!deleted) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    res.status(204).send();
  });

  // Export to JSONL
  app.post('/export', (req: Request, res: Response) => {
    try {
      db.setPrefix(defaultPrefix);
      const filepath = req.body.filepath || getDefaultDataPath();
      const items = db.getAll();
      const comments = db.getAllComments();
      const dependencyEdges = db.getAllDependencyEdges();
      exportToJsonl(items, comments, filepath, dependencyEdges);
      res.json({ message: 'Export successful', filepath, count: items.length, commentCount: comments.length });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Import from JSONL
  app.post('/import', (req: Request, res: Response) => {
    try {
      db.setPrefix(defaultPrefix);
      const filepath = req.body.filepath || getDefaultDataPath();
      const { items, comments, dependencyEdges } = importFromJsonl(filepath);
      // SAFETY: db.import() is destructive (clears all items before inserting).
      // This is intentional here — the API import endpoint replaces the entire
      // database with the contents of the JSONL file.
      db.import(items, dependencyEdges);
      db.importComments(comments);
      res.json({ message: 'Import successful', count: items.length, commentCount: comments.length });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return app;
}
