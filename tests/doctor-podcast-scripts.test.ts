import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WorkItem } from '../src/types.js';
import {
  SCRIPT_BEARING_STAGES,
  appendKeyFileEntry,
  extractPodcastScriptPaths,
  findPodcastScriptForItem,
  validatePodcastScripts,
} from '../src/doctor/podcast-scripts-check.js';

const baseItem = (overrides: Partial<WorkItem>): WorkItem => ({
  id: 'WL-POD-1',
  title: 'My Episode',
  description: '',
  status: 'open',
  priority: 'medium',
  sortIndex: 0,
  parentId: null,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  tags: [],
  assignee: '',
  stage: 'plan_complete',
  issueType: 'podcast',
  createdBy: '',
  deletedBy: '',
  deleteReason: '',
  risk: '',
  effort: '',
  ...overrides,
});

describe('doctor podcast-scripts check', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-scripts-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeScript = (relpath: string): string => {
    const full = path.join(root, relpath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'Nova: hello');
    return relpath;
  };

  it('does not flag a podcast item with a resolvable script entry', () => {
    const rel = writeScript('.llm-wiki/wiki/podcast/my-episode/my-episode.podcast.md');
    const items = [
      baseItem({
        description: `Scope.\n\n**Key Files:**\n- \`${rel}\``,
      }),
    ];
    expect(validatePodcastScripts(items, root)).toHaveLength(0);
  });

  it('flags a podcast item at a script-bearing stage with no script entry', () => {
    for (const stage of SCRIPT_BEARING_STAGES) {
      const items = [
        baseItem({
          id: `WL-${stage}`,
          stage,
          description: 'Scope only.\n\n**Key Files:**\n- `docs/other.md`',
        }),
      ];
      const findings = validatePodcastScripts(items, root);
      expect(findings).toHaveLength(1);
      const finding = findings[0];
      expect(finding.checkId).toBe('podcast-scripts.missing');
      expect(finding.type).toBe('missing-podcast-script');
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('Key Files:');
      expect(finding.message).toContain('Fix:');
    }
  });

  it('flags an unresolved podcast script path regardless of stage', () => {
    const items = [
      baseItem({
        stage: 'idea',
        description:
          'Scope.\n\n**Key Files:**\n- `.llm-wiki/wiki/podcast/gone/gone.podcast.md`',
      }),
    ];
    const findings = validatePodcastScripts(items, root);
    expect(findings).toHaveLength(1);
    expect(findings[0].checkId).toBe('podcast-scripts.unresolved');
    expect(findings[0].type).toBe('unresolved-podcast-script');
    expect(findings[0].context.unresolvedPaths).toEqual([
      '.llm-wiki/wiki/podcast/gone/gone.podcast.md',
    ]);
  });

  it('does not flag a podcast item at an early stage with no entry', () => {
    const items = [baseItem({ stage: 'idea', description: 'Just an idea.' })];
    expect(validatePodcastScripts(items, root)).toHaveLength(0);
  });

  it('does not flag non-podcast items', () => {
    const items = [
      baseItem({ issueType: 'task', stage: 'plan_complete', description: 'No files.' }),
    ];
    expect(validatePodcastScripts(items, root)).toHaveLength(0);
  });

  it('skips deleted items', () => {
    const items = [
      baseItem({ status: 'deleted', stage: 'done', description: 'No files.' }),
    ];
    expect(validatePodcastScripts(items, root)).toHaveLength(0);
  });

  it('proposes an idempotent fix when a matching script can be found', () => {
    const rel = writeScript('.llm-wiki/wiki/podcast/my-episode/my-episode.podcast.md');
    const items = [baseItem({ title: 'My Episode', description: '' })];
    const findings = validatePodcastScripts(items, root);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.safe).toBe(true);
    expect(finding.context.candidatePath).toBe(rel);

    const proposed = (finding.proposedFix as Record<string, string>).description;
    expect(proposed).toContain(`- \`${rel}\``);
    // Idempotent: appending again is a no-op.
    expect(appendKeyFileEntry(proposed, rel)).toBe(proposed);
  });

  it('reports no proposed fix when no matching script exists', () => {
    const items = [baseItem({ title: 'Nothing Here', description: 'Scope.' })];
    const findings = validatePodcastScripts(items, root);
    expect(findings).toHaveLength(1);
    expect(findings[0].proposedFix).toBeNull();
    expect(findings[0].safe).toBe(false);
  });
});

describe('podcast-scripts helpers', () => {
  it('extractPodcastScriptPaths only returns .podcast.md entries', () => {
    const description =
      '**Key Files:**\n- `.llm-wiki/wiki/syntheses/source.md`\n' +
      '- `.llm-wiki/wiki/podcast/x/x.podcast.md`';
    expect(extractPodcastScriptPaths(description)).toEqual([
      '.llm-wiki/wiki/podcast/x/x.podcast.md',
    ]);
  });

  it('appendKeyFileEntry preserves existing entries and is idempotent', () => {
    const description =
      'Scope.\n\n**Key Files:**\n- `.llm-wiki/wiki/syntheses/source.md`';
    const out = appendKeyFileEntry(
      description,
      '.llm-wiki/wiki/podcast/x/x.podcast.md',
    );
    expect(out).toContain('- `.llm-wiki/wiki/syntheses/source.md`');
    expect(out).toContain('- `.llm-wiki/wiki/podcast/x/x.podcast.md`');
    expect(appendKeyFileEntry(out, '.llm-wiki/wiki/podcast/x/x.podcast.md')).toBe(out);
  });

  it('findPodcastScriptForItem returns a worklog-root-relative path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-find-'));
    try {
      const full = path.join(
        root,
        '.llm-wiki/wiki/podcast/my-episode/my-episode.podcast.md',
      );
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x');
      const found = findPodcastScriptForItem(baseItem({ title: 'My Episode' }), root);
      expect(found).toBe('.llm-wiki/wiki/podcast/my-episode/my-episode.podcast.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
