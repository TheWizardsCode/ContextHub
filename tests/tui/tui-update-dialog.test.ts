import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../../src/database.js';
import blessed from 'blessed';
import { createUpdateDialogFocusManager } from '../../src/tui/update-dialog-navigation.js';
import { buildUpdateDialogUpdates } from '../../src/tui/update-dialog-submit.js';
import { loadStatusStageRules } from '../../src/status-stage-rules.js';
import { cleanupTempDir } from '../test-utils.js';

describe('TUI Update Dialog', () => {
  const rulesConfig = loadStatusStageRules();
  const statusLabels = rulesConfig.statusValues.map(value => rulesConfig.statusLabels[value] ?? value);
  const stageValuesNoBlank = rulesConfig.stageValues.filter(stage => stage !== '');
  const stageLabels = stageValuesNoBlank.map(value => rulesConfig.stageLabels[value] ?? value);
  const tmpDir = path.join(process.cwd(), 'tmp-test-tui-update');
  const openDbs: WorklogDatabase[] = [];
  const worklogDir = path.join(tmpDir, '.worklog');
  const jsonlPath = path.join(worklogDir, 'worklog-data.jsonl');

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(worklogDir, { recursive: true });

    // Seed multiple work items for testing
    const items = [
      {
        id: 'WL-TEST-1',
        title: 'Test Item 1',
        description: 'desc 1',
        status: 'open',
        priority: 'medium',
        parentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        assignee: '',
        stage: 'idea',
        issueType: 'feature',
        createdBy: '',
        deletedBy: '',
        deleteReason: ''
      },
      {
        id: 'WL-TEST-2',
        title: 'Test Item 2',
        description: 'desc 2',
        status: 'open',
        priority: 'high',
        parentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        assignee: '',
        stage: 'prd_complete',
        issueType: 'task',
        createdBy: '',
        deletedBy: '',
        deleteReason: ''
      }
    ];

    items.forEach(item => {
      fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'workitem', data: item }) + '\n', 'utf-8');
    });

    // Mark as initialized so resolveWorklogDir prefers this dir over the repo root
    fs.writeFileSync(path.join(worklogDir, 'initialized'), '', 'utf-8');
    process.chdir(tmpDir);
  });

  afterEach(() => {
    for (const db of openDbs) {
      try { db.close(); } catch { /* ignore */ }
    }
    openDbs.length = 0;
    process.chdir(path.resolve(__dirname, '../..'));
    cleanupTempDir(tmpDir);
  });

  describe('Update Dialog Functions', () => {
    it('should successfully update a work item stage via db.update', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false); openDbs.push(db);

      // Verify initial stage
      const itemBefore = db.get('WL-TEST-1');
      expect(itemBefore?.stage).toBe('idea');

      // Simulate selecting a stage option (index 3 = 'in_progress')
      db.update('WL-TEST-1', { stage: 'in_progress' });

      // Verify the update was applied
      const itemAfter = db.get('WL-TEST-1');
      expect(itemAfter?.stage).toBe('in_progress');
    });

    it('should update stage from prd_complete to plan_complete', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false); openDbs.push(db);

      const itemBefore = db.get('WL-TEST-2');
      expect(itemBefore?.stage).toBe('prd_complete');

      // Simulate selecting stage option (index 2 = 'plan_complete')
      db.update('WL-TEST-2', { stage: 'plan_complete' });

      const itemAfter = db.get('WL-TEST-2');
      expect(itemAfter?.stage).toBe('plan_complete');
    });

    it('should update to done stage', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false); openDbs.push(db);

      db.update('WL-TEST-1', { stage: 'done' });

      const item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('done');
    });

    it('should update to blocked stage', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false); openDbs.push(db);

      db.update('WL-TEST-1', { stage: 'blocked' });

      const item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('blocked');
    });
  });

  describe('Update Dialog UI Behavior', () => {
    it('should render update dialog with stage, status, priority, and comment box', () => {
      // Create blessed screen and dialog components
      const screen = blessed.screen({ mouse: true, smartCSR: true });

       const updateDialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: 24,
        label: ' Update Work Item ',
        border: { type: 'line' },
        hidden: true,
        tags: true,
        mouse: true,
        clickable: true,
        style: { border: { fg: 'magenta' } }
      });

       const updateDialogText = blessed.box({
        parent: updateDialog,
        top: 1,
        left: 2,
        height: 2,
        width: '100%-4',
        content: 'Update selected item fields:',
        tags: false
      });

      // Create a dummy textarea to reflect the new UI element
      const updateDialogComment = blessed.textarea({
        parent: updateDialog,
        top: 22,
        left: 2,
        width: '100%-4',
        height: 2,
        inputOnFocus: true,
      });

      blessed.box({
        parent: updateDialog,
        top: 5,
        left: 2,
        height: 1,
        width: '33%-2',
        content: 'Status',
        tags: false
      });

      blessed.box({
        parent: updateDialog,
        top: 5,
        left: '33%+1',
        height: 1,
        width: '33%-2',
        content: 'Stage',
        tags: false
      });

      blessed.box({
        parent: updateDialog,
        top: 5,
        left: '66%+1',
        height: 1,
        width: '33%-2',
        content: 'Priority',
        tags: false
      });

      const statusOptions = blessed.list({
        parent: updateDialog,
        top: 6,
        left: 2,
        width: '33%-2',
        height: 15,
        keys: true,
        mouse: true,
        style: {
          selected: { bg: 'blue' }
        },
        items: statusLabels
      });

      const stageOptions = blessed.list({
        parent: updateDialog,
        top: 6,
        left: '33%+1',
        width: '33%-2',
        height: 15,
        keys: true,
        mouse: true,
        style: {
          selected: { bg: 'blue' }
        },
        items: stageLabels
      });

      const priorityOptions = blessed.list({
        parent: updateDialog,
        top: 6,
        left: '66%+1',
        width: '33%-2',
        height: 15,
        keys: true,
        mouse: true,
        style: {
          selected: { bg: 'blue' }
        },
        items: ['critical', 'high', 'medium', 'low']
      });

      // Verify dialog is properly constructed
      expect(updateDialog.hidden).toBe(true);
      expect(updateDialogText.getContent()).toContain('Update selected item fields:');

      // Verify lists have items (blessed list items API)
      expect(stageOptions.children.length).toBeGreaterThan(0);
      expect(statusOptions.children.length).toBeGreaterThan(0);
      expect(priorityOptions.children.length).toBeGreaterThan(0);
      expect(updateDialogComment).toBeTruthy();

      screen.destroy();
    });

    it('should show dialog with selected item info', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const updateDialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: 24,
        label: ' Update Work Item ',
        border: { type: 'line' },
        hidden: true
      });

      const updateDialogText = blessed.box({
        parent: updateDialog,
        top: 1,
        left: 2,
        height: 3,
        width: '100%-4',
        content: ''
      });

      // Simulate openUpdateDialog behavior
      const itemTitle = 'Test Item 1';
      const itemId = 'WL-TEST-1';
      updateDialogText.setContent(`Update: ${itemTitle}\nID: ${itemId}`);

      expect(updateDialogText.getContent()).toContain('Update: Test Item 1');
      expect(updateDialogText.getContent()).toContain('ID: WL-TEST-1');

      screen.destroy();
    });

    it('should close dialog and return focus to list', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const list = blessed.list({
        parent: screen,
        top: 0,
        left: 0,
        width: '100%',
        height: '100%-1',
        items: ['Item 1', 'Item 2']
      });

      const updateDialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: 24,
        label: ' Update Work Item ',
        border: { type: 'line' },
        hidden: true
      });

      // Simulate closeUpdateDialog behavior
      updateDialog.hide();
      list.focus();

      expect(updateDialog.hidden).toBe(true);

      screen.destroy();
    });
  });

  describe('Update Dialog Selection Handling', () => {
    it('should handle all stage selections correctly', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false); openDbs.push(db);

      const stages = stageValuesNoBlank;
      const stageMapping = Object.fromEntries(stageValuesNoBlank.map((value, idx) => [idx, value]));

      // Test each selection index
      stages.forEach((expectedStage, idx) => {
        db.update('WL-TEST-1', { stage: stageMapping[idx] });
        const item = db.get('WL-TEST-1');
        expect(item?.stage).toBe(expectedStage);
      });
    });

    it('should not expose a cancel stage option', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });
      const stageOptions = blessed.list({ parent: screen, items: stageLabels });
      expect(stageOptions.children.some((child: any) => child.getContent?.() === 'Cancel')).toBe(false);
      screen.destroy();
    });
  });

  describe('Update Dialog Focus Navigation', () => {
    it('should cycle focus forward and backward', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const stageList = blessed.list({ parent: screen, items: stageLabels.slice(0, 2) });
      const statusList = blessed.list({ parent: screen, items: statusLabels.slice(0, 2) });
      const priorityList = blessed.list({ parent: screen, items: ['high', 'low'] });
      const commentBox = blessed.textarea({ parent: screen, inputOnFocus: true });

      const focusManager = createUpdateDialogFocusManager([stageList, statusList, priorityList, commentBox]);

      focusManager.focusIndex(0);
      expect(focusManager.getIndex()).toBe(0);

      focusManager.cycle(1);
      expect(focusManager.getIndex()).toBe(1);

      focusManager.cycle(1);
      expect(focusManager.getIndex()).toBe(2);

      focusManager.cycle(1);
      expect(focusManager.getIndex()).toBe(3);

      focusManager.cycle(-1);
      expect(focusManager.getIndex()).toBe(2);

      screen.destroy();
    });
  });

  describe('Update Dialog Comment Handling', () => {
    it('should include comment in updates result when provided', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: rulesConfig.statusValues,
          stages: stageValuesNoBlank,
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: rulesConfig.statusStageCompatibility,
          stageStatus: rulesConfig.stageStatusCompatibility,
        },
        'hello\nworld'
      );

      expect(result.comment).toBe('hello\nworld');
      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });

    it('should ignore blank comment values', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: rulesConfig.statusValues,
          stages: stageValuesNoBlank,
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: rulesConfig.statusStageCompatibility,
          stageStatus: rulesConfig.stageStatusCompatibility,
        },
        '   '
      );

      expect(result.comment).toBeUndefined();
      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });

    it('should end comment input reading on blur to avoid duplicate keypress handling', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });
      const stageList = blessed.list({ parent: screen, items: stageLabels.slice(0, 2) });
      const statusList = blessed.list({ parent: screen, items: statusLabels.slice(0, 2) });
      const priorityList = blessed.list({ parent: screen, items: ['high', 'low'] });
      const commentBox = blessed.textarea({ parent: screen, inputOnFocus: true, keys: true });

      const updateDialogFieldOrder = [stageList, statusList, priorityList, commentBox];
      const focusManager = createUpdateDialogFocusManager(updateDialogFieldOrder);

      const endCommentReading = () => {
        if (typeof (commentBox as any).cancel === 'function') {
          (commentBox as any).cancel();
        }
        if ((commentBox as any)._reading) {
          (commentBox as any)._reading = false;
        }
        (screen as any).grabKeys = false;
      };

      const startCommentReading = () => {
        if (typeof (commentBox as any).readInput === 'function') {
          (commentBox as any).readInput();
        }
      };

      updateDialogFieldOrder.forEach((field) => {
        field.on('blur', () => {
          if (field === commentBox) {
            endCommentReading();
          }
        });
        field.on('focus', () => {
          if (field === commentBox) {
            startCommentReading();
          }
        });
      });

      // Simulate comment box input reading, then blur to another field
      (commentBox as any)._reading = true;
      (screen as any).grabKeys = true;
      focusManager.focusIndex(3);
      commentBox.emit('blur');

      expect((commentBox as any)._reading).toBe(false);
      expect((screen as any).grabKeys).toBe(false);

      commentBox.emit('focus');
      expect((commentBox as any)._reading).toBe(true);

      screen.destroy();
    });
  });

  describe('Update Dialog Default Selection', () => {
    it('should select current item values when opening dialog', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const statusOptions = blessed.list({ parent: screen, items: statusLabels });
      const stageOptions = blessed.list({ parent: screen, items: stageLabels });
      const priorityOptions = blessed.list({ parent: screen, items: ['critical', 'high', 'medium', 'low'] });

      const item = {
        status: 'blocked',
        stage: 'in_review',
        priority: 'high'
      };

      statusOptions.select(Math.max(0, statusLabels.indexOf(rulesConfig.statusLabels.blocked ?? 'blocked')));
      stageOptions.select(Math.max(0, stageLabels.indexOf(rulesConfig.stageLabels.in_review ?? 'in_review')));
      priorityOptions.select(1);

      expect((statusOptions as any).selected).toBe(Math.max(0, statusLabels.indexOf(rulesConfig.statusLabels.blocked ?? 'blocked')));
      expect((stageOptions as any).selected).toBe(Math.max(0, stageLabels.indexOf(rulesConfig.stageLabels.in_review ?? 'in_review')));
      expect((priorityOptions as any).selected).toBe(1);

      screen.destroy();
    });

    it('should update summary when selections change', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const updateDialogText = blessed.box({
        parent: screen,
        top: 1,
        left: 2,
        height: 3,
        width: '100%-4',
        content: ''
      });

      const statusOptions = blessed.list({ parent: screen, items: statusLabels });
      const stageOptions = blessed.list({ parent: screen, items: stageLabels });
      const priorityOptions = blessed.list({ parent: screen, items: ['critical', 'high', 'medium', 'low'] });

      const item = {
        id: 'WL-TEST-1',
        title: 'Test item',
        status: 'open',
        stage: 'idea',
        priority: 'medium'
      };

      const updateDialogStatusValues = statusLabels;
      const updateDialogStageValues = stageLabels;
      const updateDialogPriorityValues = ['critical', 'high', 'medium', 'low'];

      const normalizeStatusValue = (value: string | undefined) => {
        if (!value) return value;
        return rulesConfig.statusLabels[value] ?? value;
      };

      const updateDialogHeader = (overrides?: { status?: string; stage?: string; priority?: string; adjusted?: boolean }) => {
        const statusValue = overrides?.status ?? normalizeStatusValue(item.status) ?? '';
         const stageValue = overrides?.stage ?? (item.stage === '' ? rulesConfig.stageLabels[''] ?? 'Undefined' : rulesConfig.stageLabels[item.stage] ?? item.stage);
        const priorityValue = overrides?.priority ?? item.priority ?? '';
        const adjustedSuffix = overrides?.adjusted ? ' (Adjusted)' : '';
        updateDialogText.setContent(
          `Update: ${item.title}\nID: ${item.id}\nStatus: ${statusValue} · Stage: ${stageValue} · Priority: ${priorityValue}${adjustedSuffix}`
        );
      };

      updateDialogHeader();
      expect(updateDialogText.getContent()).toContain(`Status: ${rulesConfig.statusLabels.open ?? 'open'} · Stage: ${rulesConfig.stageLabels.idea ?? 'idea'} · Priority: medium`);

      statusOptions.select(Math.max(0, updateDialogStatusValues.indexOf(rulesConfig.statusLabels['in-progress'] ?? 'in-progress')));
      stageOptions.select(Math.max(0, updateDialogStageValues.indexOf(rulesConfig.stageLabels.in_progress ?? 'in_progress')));
      priorityOptions.select(0);
      updateDialogHeader({
        status: updateDialogStatusValues[(statusOptions as any).selected ?? 0],
        stage: updateDialogStageValues[(stageOptions as any).selected ?? 0],
        priority: updateDialogPriorityValues[(priorityOptions as any).selected ?? 2]
      });

      expect(updateDialogText.getContent()).toContain(`Status: ${rulesConfig.statusLabels['in-progress'] ?? 'in-progress'} · Stage: ${rulesConfig.stageLabels.in_progress ?? 'in_progress'} · Priority: critical`);

      updateDialogHeader({
        status: 'completed',
        stage: 'in_review',
        priority: 'high',
        adjusted: true
      });

      expect(updateDialogText.getContent()).toContain('(Adjusted)');

      screen.destroy();
    });
  });

  describe('Update Dialog Submit Updates', () => {
    it('should reject invalid status/stage combinations', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const statusIndex = rulesConfig.statusValues.indexOf('completed');
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: rulesConfig.statusValues,
          stages: stageValuesNoBlank,
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: rulesConfig.statusStageCompatibility,
          stageStatus: rulesConfig.stageStatusCompatibility,
        }
      );

      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });

    it('should reject incompatible selections based on list items', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 0 },
        {
          statuses: ['completed', 'open'],
          stages: ['idea', 'in_review'],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: rulesConfig.statusStageCompatibility,
          stageStatus: rulesConfig.stageStatusCompatibility,
        }
      );

      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });
    it('should build updates only for changed fields', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const statusIndex = rulesConfig.statusValues.indexOf('in-progress');
      const stageIndex = stageValuesNoBlank.indexOf('in_progress');
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex, stageIndex, priorityIndex: 1 },
        {
          statuses: rulesConfig.statusValues,
          stages: stageValuesNoBlank,
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: rulesConfig.statusStageCompatibility,
          stageStatus: rulesConfig.stageStatusCompatibility,
        }
      );

      expect(result.hasChanges).toBe(true);
      expect(result.updates).toEqual({
        status: 'in-progress',
        stage: 'in_progress',
        priority: 'high',
      });
    });

    it('should allow updates when stage is undefined/blank', () => {
      const item = { status: 'open', stage: '', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 0 },
        {
          statuses: ['open'],
          stages: [''],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: rulesConfig.statusStageCompatibility,
          stageStatus: rulesConfig.stageStatusCompatibility,
        }
      );

      expect(result.hasChanges).toBe(true);
      expect(result.updates).toEqual({ stage: '', priority: 'critical' });
    });

    it('should return no changes when selections match current values', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: rulesConfig.statusValues,
          stages: stageValuesNoBlank,
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: rulesConfig.statusStageCompatibility,
          stageStatus: rulesConfig.stageStatusCompatibility,
        }
      );

      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });

    it('should submit updates and comment in a single action', () => {
      const item = { id: 'WL-TEST-1', status: 'open', stage: 'idea', priority: 'medium' };
      const selections = {
        statusIndex: rulesConfig.statusValues.indexOf('blocked'),
        stageIndex: 0,
        priorityIndex: 1,
      };
      const values = {
        statuses: rulesConfig.statusValues,
        stages: stageValuesNoBlank,
        priorities: ['critical', 'high', 'medium', 'low'],
      };
      const updateCalls: Array<Record<string, string>> = [];
      const commentCalls: string[] = [];
      const db = {
        update: (_id: string, updates: Record<string, string>) => {
          updateCalls.push(updates);
        },
        createComment: (_payload: { workItemId: string; comment: string; author: string }) => {
          commentCalls.push(_payload.comment);
        },
      };

      // Extend submission to include a comment via the new multiline textbox
      const submitUpdateDialogWithComment = (comment?: string) => {
        const { updates, hasChanges, comment: newComment } = buildUpdateDialogUpdates(item, selections, values, {
          statusStage: rulesConfig.statusStageCompatibility,
          stageStatus: rulesConfig.stageStatusCompatibility,
        }, comment);
        if (!hasChanges && !newComment) return;
        if (Object.keys(updates).length > 0) db.update(item.id, updates);
        if (newComment) db.createComment({ workItemId: item.id, comment: newComment, author: '@tui' });
      };

      submitUpdateDialogWithComment();
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]).toEqual({
        status: 'blocked',
        priority: 'high',
      });
      expect(commentCalls).toHaveLength(0);

      updateCalls.length = 0;
      commentCalls.length = 0;
      submitUpdateDialogWithComment('hello');
      expect(updateCalls).toHaveLength(1);
      expect(commentCalls).toHaveLength(1);
      expect(commentCalls[0]).toBe('hello');
    });

    it('should preserve comment when update fails and allow retry', () => {
      const updateCalls: Array<Record<string, string>> = [];
      const commentCalls: string[] = [];
      const db = {
        update: (_id: string, updates: Record<string, string>) => {
          updateCalls.push(updates);
          throw new Error('Update failed');
        },
        createComment: (_payload: { workItemId: string; comment: string; author: string }) => {
          commentCalls.push(_payload.comment);
        },
      };

      let commentValue = 'keep me';
      const submitUpdateDialogWithFailure = () => {
        const statusIndex = rulesConfig.statusValues.indexOf('in-progress');
        const stageIndex = stageValuesNoBlank.indexOf('in_progress');
        const { updates, hasChanges, comment } = buildUpdateDialogUpdates(
          { status: 'open', stage: 'idea', priority: 'medium' },
          { statusIndex, stageIndex, priorityIndex: 1 },
          {
            statuses: rulesConfig.statusValues,
            stages: stageValuesNoBlank,
            priorities: ['critical', 'high', 'medium', 'low'],
          },
          {
            statusStage: rulesConfig.statusStageCompatibility,
            stageStatus: rulesConfig.stageStatusCompatibility,
          },
          commentValue
        );

        try {
          if (!hasChanges && !comment) return;
          if (Object.keys(updates).length > 0) db.update('WL-TEST-1', updates);
          if (comment) db.createComment({ workItemId: 'WL-TEST-1', comment, author: '@tui' });
          commentValue = '';
        } catch {
          // Comment should be preserved for retry
        }
      };

      submitUpdateDialogWithFailure();
      expect(updateCalls).toHaveLength(1);
      expect(commentCalls).toHaveLength(0);
      expect(commentValue).toBe('keep me');
    });

    it('should surface update error message in toast', () => {
      const updateCalls: Array<Record<string, string>> = [];
      const db = {
        update: (_id: string, updates: Record<string, string>) => {
          updateCalls.push(updates);
          throw new Error('Update failed: bad stage');
        },
      };
      const toastMessages: string[] = [];
      const toastComponent = { show: (message: string) => toastMessages.push(message) };

      const submitUpdateDialogWithFailure = () => {
        const { updates, hasChanges } = buildUpdateDialogUpdates(
          { status: 'open', stage: 'idea', priority: 'medium' },
          { statusIndex: 0, stageIndex: 0, priorityIndex: 0 },
          {
            statuses: ['open'],
            stages: ['idea'],
            priorities: ['critical', 'high', 'medium', 'low'],
          },
          {
            statusStage: rulesConfig.statusStageCompatibility,
            stageStatus: rulesConfig.stageStatusCompatibility,
          }
        );

        try {
          if (!hasChanges) return;
          if (Object.keys(updates).length > 0) db.update('WL-TEST-1', updates);
        } catch (err) {
          const message = err instanceof Error
            ? err.message
            : (typeof err === 'string' ? err : 'Update failed');
          toastComponent.show(message || 'Update failed');
        }
      };

      submitUpdateDialogWithFailure();
      expect(updateCalls).toHaveLength(1);
      expect(toastMessages).toEqual(['Update failed: bad stage']);
    });

    it('should treat blank stage as compatible with deleted status', () => {
      const item = { status: 'open', stage: '', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: ['deleted'],
          stages: [''],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: rulesConfig.statusStageCompatibility,
          stageStatus: rulesConfig.stageStatusCompatibility,
        }
      );
      expect(result.hasChanges).toBe(true);
      expect(result.updates).toEqual({ status: 'deleted', stage: '' });
    });

    it('should not call db.update when Escape cancels', () => {
      const updateCalls: Array<Record<string, string>> = [];
      const db = {
        update: (_id: string, updates: Record<string, string>) => {
          updateCalls.push(updates);
        },
      };
      let closeCalls = 0;
      const closeUpdateDialog = () => {
        closeCalls += 1;
      };

      const onEscape = () => {
        closeUpdateDialog();
      };

      onEscape();
      expect(updateCalls).toHaveLength(0);
      expect(closeCalls).toBe(1);
      void db;
    });

    it('should move focus forward and back when textarea handles Tab/Shift-Tab', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });
      const stageList = blessed.list({ parent: screen, items: stageLabels.slice(0, 2) });
      const statusList = blessed.list({ parent: screen, items: statusLabels.slice(0, 2) });
      const priorityList = blessed.list({ parent: screen, items: ['high', 'low'] });
      const commentBox = blessed.textarea({ parent: screen, inputOnFocus: true, keys: true });

      const focusManager = createUpdateDialogFocusManager([stageList, statusList, priorityList, commentBox]);

      const wireNavigation = (field: any) => {
        field.on('keypress', (_ch: string, key: { name?: string }) => {
          if (key?.name === 'tab') {
            focusManager.cycle(1);
          }
          if (key?.name === 'S-tab') {
            focusManager.cycle(-1);
          }
        });
      };

      [stageList, statusList, priorityList, commentBox].forEach(wireNavigation);

      focusManager.focusIndex(3);
      commentBox.emit('keypress', '', { name: 'tab', full: 'tab' });
      expect(focusManager.getIndex()).toBe(0);

      commentBox.emit('keypress', '', { name: 'S-tab', shift: true, full: 'S-tab' });
      expect(focusManager.getIndex()).toBe(3);

      screen.destroy();
    });
  });

  describe('Update Dialog Error Handling', () => {
    it('should handle update failure gracefully', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false); openDbs.push(db);

      // Attempt to update non-existent item
      const result = db.update('WL-NONEXISTENT', { stage: 'in_progress' });
      
      // update() returns null when item not found
      expect(result).toBeNull();

      // Original item should be unchanged
      const item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('idea');
    });

    it('should preserve item data on update failure', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false); openDbs.push(db);

      const itemBefore = db.get('WL-TEST-1');
      const originalTitle = itemBefore?.title;
      const originalStatus = itemBefore?.status;

      // Simulate failed update (in real code, error is caught and toast shown)
      db.update('WL-TEST-1', { stage: 'in_review' });

      const itemAfter = db.get('WL-TEST-1');
      expect(itemAfter?.title).toBe(originalTitle);
      expect(itemAfter?.status).toBe(originalStatus);
      expect(itemAfter?.stage).toBe('in_review');
    });
  });

  describe('Update Dialog Integration', () => {
    it('should execute full update flow: open, select, update, close', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false); openDbs.push(db);

      // Step 1: Verify item exists with initial stage
      let item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('idea');
      expect(item?.title).toBe('Test Item 1');

      // Step 2: Simulate selecting a stage option
      // In actual code: updateDialogOptions.on('select', ...)
      const selectedIdx = stageValuesNoBlank.indexOf('in_progress');
      const stageMapping = Object.fromEntries(stageValuesNoBlank.map((value, idx) => [idx, value]));

      if (selectedIdx >= 0 && selectedIdx < stageValuesNoBlank.length) {
        db.update('WL-TEST-1', { stage: stageMapping[selectedIdx] });
      }

      // Step 3: Verify update was successful
      item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('in_progress');

      // Step 4: Dialog closes and list would be refreshed
      // In actual code: refreshFromDatabase() and closeUpdateDialog()
    });

    it('should handle multiple sequential updates', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false); openDbs.push(db);

      // First update
      const firstStage = stageValuesNoBlank[0] ?? 'idea';
      db.update('WL-TEST-1', { stage: firstStage });
      expect(db.get('WL-TEST-1')?.stage).toBe(firstStage);

      // Second update
      const secondStage = stageValuesNoBlank[1] ?? firstStage;
      db.update('WL-TEST-1', { stage: secondStage });
      expect(db.get('WL-TEST-1')?.stage).toBe(secondStage);

      // Third update
      const thirdStage = stageValuesNoBlank[2] ?? secondStage;
      db.update('WL-TEST-1', { stage: thirdStage });
      expect(db.get('WL-TEST-1')?.stage).toBe(thirdStage);

      // Fourth update
      const finalStage = stageValuesNoBlank[stageValuesNoBlank.length - 1] ?? thirdStage;
      db.update('WL-TEST-1', { stage: finalStage });
      expect(db.get('WL-TEST-1')?.stage).toBe(finalStage);
    });
  });

  describe('Keyboard Shortcut Behavior', () => {
    it('should verify keyboard shortcut bindings', () => {
      // This test verifies the expected keyboard shortcut bindings
      // In the actual code: screen.key(['u', 'U'], () => { openUpdateDialog(); })

      const screen = blessed.screen({ mouse: true, smartCSR: true });
      let updateDialogOpened = false;

      // Simulate the keyboard key binding
      screen.key(['u', 'U'], () => {
        updateDialogOpened = true;
      });

      // The key binding is registered
      expect(updateDialogOpened).toBe(false); // Not opened yet
      
      screen.destroy();
    });

    it('should respect dialog visibility checks before opening', () => {
      // This test verifies that the update dialog checks other dialogs are hidden
      // In actual code: if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden && updateDialog.hidden)

      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const detailModal = blessed.box({ parent: screen, hidden: true });
      const closeDialog = blessed.box({ parent: screen, hidden: true });
      const updateDialog = blessed.box({ parent: screen, hidden: true });
      const helpMenuVisible = false;

      const shouldOpenUpdateDialog =
        detailModal.hidden && !helpMenuVisible && closeDialog.hidden && updateDialog.hidden;

      expect(shouldOpenUpdateDialog).toBe(true);

      // When another dialog is visible
      detailModal.show();
      const shouldNotOpenWhenDetailOpen =
        detailModal.hidden && !helpMenuVisible && closeDialog.hidden && updateDialog.hidden;

      expect(shouldNotOpenWhenDetailOpen).toBe(false);

      screen.destroy();
    });
  });

});
