/**
 * packages/herdr/src/pane-title.test.ts — unit tests for the shared pane-title
 * builders (WL-0MSJ4E8UA005KG9Y).
 *
 * Covers every spawn path:
 *  1. Manually triggered agent panes (skill shortcuts, /intake, /plan)
 *  2. Free-form /prompt: panes
 *  3. Shell-command panes (!!/! via run-in-pane.sh)
 *  4. Downtime dispatcher panes
 * plus the shared length bound (AC5) and truncation behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PANE_TITLE_LENGTH,
  truncatePaneTitle,
  isAgentCommand,
  stripSkillName,
  stripAgentPromptPrefix,
  buildManuallyTriggeredPaneTitle,
  buildShellPaneTitle,
  buildDowntimePaneTitle,
} from './pane-title';

describe('truncatePaneTitle', () => {
  it('keeps titles within the maximum length unchanged', () => {
    expect(truncatePaneTitle('Short title')).toBe('Short title');
    expect(truncatePaneTitle('x'.repeat(MAX_PANE_TITLE_LENGTH))).toHaveLength(MAX_PANE_TITLE_LENGTH);
  });

  it('truncates longer titles with a trailing ellipsis (AC5)', () => {
    const long = 'y'.repeat(MAX_PANE_TITLE_LENGTH + 10);
    const result = truncatePaneTitle(long);
    expect(result).toHaveLength(MAX_PANE_TITLE_LENGTH);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('y'.repeat(MAX_PANE_TITLE_LENGTH - 1))).toBe(true);
  });
});

describe('isAgentCommand', () => {
  it('recognises skill, intake, plan and prompt commands', () => {
    expect(isAgentCommand('/skill:implement WL-1')).toBe(true);
    expect(isAgentCommand('/intake WL-1')).toBe(true);
    expect(isAgentCommand('/plan WL-1')).toBe(true);
    expect(isAgentCommand('/prompt:Hello there')).toBe(true);
  });

  it('rejects shell and wl commands', () => {
    expect(isAgentCommand('!!wl update WL-1')).toBe(false);
    expect(isAgentCommand('!ls -la')).toBe(false);
    expect(isAgentCommand('wl list open')).toBe(false);
  });
});

describe('stripSkillName', () => {
  it('extracts the skill token from /skill: commands', () => {
    expect(stripSkillName('/skill:implement WL-1')).toBe('implement');
    expect(stripSkillName('/skill:audit WL-1')).toBe('audit');
  });

  it('maps /intake and /plan to their own tokens', () => {
    expect(stripSkillName('/intake WL-1')).toBe('intake');
    expect(stripSkillName('/plan WL-1')).toBe('plan');
  });

  it('returns null for /prompt: and non-agent commands', () => {
    expect(stripSkillName('/prompt:hello')).toBeNull();
    expect(stripSkillName('!!wl update WL-1')).toBeNull();
  });
});

describe('stripAgentPromptPrefix', () => {
  it('removes the /prompt: routing prefix', () => {
    expect(stripAgentPromptPrefix('/prompt:Review the item')).toBe('Review the item');
  });

  it('returns non-prompt commands unchanged', () => {
    expect(stripAgentPromptPrefix('/skill:implement WL-1')).toBe('/skill:implement WL-1');
  });
});

describe('buildManuallyTriggeredPaneTitle', () => {
  it('formats skill commands as "Manually triggered <skill> <title> - <id>" (AC1)', () => {
    expect(buildManuallyTriggeredPaneTitle('/skill:implement WL-1', 'Fix the bug', 'WL-1')).toBe(
      'Manually triggered implement Fix the bug - WL-1',
    );
  });

  it('formats /intake and /plan with their skill tokens', () => {
    expect(buildManuallyTriggeredPaneTitle('/intake WL-2', 'New idea', 'WL-2')).toBe(
      'Manually triggered intake New idea - WL-2',
    );
    expect(buildManuallyTriggeredPaneTitle('/plan WL-3', 'Plan me', 'WL-3')).toBe(
      'Manually triggered plan Plan me - WL-3',
    );
  });

  it('handles commands with no item context', () => {
    expect(buildManuallyTriggeredPaneTitle('/skill:audit', undefined, undefined)).toBe(
      'Manually triggered audit',
    );
  });

  it('formats /prompt: commands from their first words (AC2)', () => {
    expect(buildManuallyTriggeredPaneTitle('/prompt:Review the current work item', undefined, undefined)).toBe(
      'Manually triggered prompt Review the current',
    );
  });

  it('falls back to a bare "Manually triggered prompt" for an empty prompt', () => {
    expect(buildManuallyTriggeredPaneTitle('/prompt:', undefined, undefined)).toBe(
      'Manually triggered prompt',
    );
  });

  it('bounds the final title to the maximum length (AC5)', () => {
    const longTitle = 'A very long work item title '.repeat(5);
    const result = buildManuallyTriggeredPaneTitle('/skill:implement WL-1', longTitle, 'WL-1');
    expect(result.length).toBeLessThanOrEqual(MAX_PANE_TITLE_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('buildShellPaneTitle', () => {
  it('prefixes the command snippet with "Shell:" (AC3)', () => {
    expect(buildShellPaneTitle('wl update WL-1 --priority high', undefined, undefined)).toBe(
      'Shell: wl update WL-1 --priority high',
    );
  });

  it('appends the work-item context when available', () => {
    expect(buildShellPaneTitle('wl update WL-1 --priority high', 'Fix the bug', 'WL-1')).toBe(
      'Shell: wl update WL-1 --priority high (Fix the bug) WL-1',
    );
  });

  it('truncates long command snippets', () => {
    const longCmd = 'echo ' + 'x'.repeat(100);
    const result = buildShellPaneTitle(longCmd, undefined, undefined);
    expect(result.length).toBeLessThanOrEqual(MAX_PANE_TITLE_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('buildDowntimePaneTitle', () => {
  it('formats the full "Downtime triggered <kind> <title> - <id>" title (AC4)', () => {
    expect(buildDowntimePaneTitle('implement', 'Implement me', 'WL-IMP')).toBe(
      'Downtime triggered implement Implement me - WL-IMP',
    );
  });

  it('falls back to "Downtime <kind>" without item context', () => {
    expect(buildDowntimePaneTitle('plan', undefined, undefined)).toBe('Downtime plan');
  });

  it('bounds the title to the maximum length (AC5)', () => {
    const longTitle = 'A very long title '.repeat(10);
    const result = buildDowntimePaneTitle('implement', longTitle, 'WL-IMP');
    expect(result.length).toBeLessThanOrEqual(MAX_PANE_TITLE_LENGTH);
  });
});
