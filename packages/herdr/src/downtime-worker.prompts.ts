/**
 * packages/herdr/src/downtime-worker.prompts.ts — the text a downtime
 * dispatch hands to a pi agent pane.
 *
 * Single responsibility: build the prompt a dispatched pane receives
 * (`buildDowntimePrompt`), the blocked-questions directive appended to every
 * prompt (`BLOCKED_QUESTIONS_INSTRUCTION`) and the audit comment recorded on a
 * successful dispatch (`buildDowntimeDispatchComment`). Pure string
 * formatting — no I/O and no dependency on the worker's deps.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Moved verbatim out of `downtime-worker.ts` by WL-0MVLII0NO007JJBA (extract
 * the downtime-worker dispatch pipeline) and re-exported from the barrel.
 * No behaviour change.
 */

import type {
  DowntimeCandidate,
  DowntimeDispatchKind,
  DowntimeSkillKind,
} from './downtime-worker.types.js';

// ── Blocked-questions prompt (implemented) ────────────────────────────

/**
 * Instruction appended to every dispatched prompt: when the skill run
 * cannot proceed because answers are needed, record the questions in a
 * comment on the work item, mark it as needing producer review, repeat the
 * questions in the final summary, and stop — never block indefinitely (parent
 * AC6).
 */
export const BLOCKED_QUESTIONS_INSTRUCTION =
  'If you cannot proceed because you need answers, record the questions in a ' +
  'comment on the work item (wl comment add <id> --comment "question: ...") and ' +
  'mark the item as needing producer review (wl update <id> --needs-producer-review ' +
  'true), repeat the questions in your final summary, then stop — do not block ' +
  'indefinitely.';

/** Build the prompt dispatched to a pi agent pane for the given candidate. */
export function buildDowntimePrompt(kind: DowntimeSkillKind, candidate: DowntimeCandidate): string {
  const skill =
    kind === 'plan' ? '/skill:plan'
    : kind === 'audit' ? '/skill:audit'
    : kind === 'implement' ? '/skill:implement'
    : kind === 'risk-effort' ? '/skill:effort-and-risk'
    : '/skill:intake';
  return [
    `Run ${skill} ${candidate.id} — ${candidate.title}.`,
    BLOCKED_QUESTIONS_INSTRUCTION,
  ].join('\n');
}

/**
 * Build the audit comment added to the item on a successful downtime
 * dispatch: author-visible statement of the automatic dispatch, the skill
 * run, the item, and the UTC timestamp. Newlines in the title are
 * collapsed so the comment stays a single clean line.
 */
export function buildDowntimeDispatchComment(
  itemId: string,
  kind: DowntimeDispatchKind,
  dispatchedAt: string,
  title?: string,
): string {
  const skill =
    kind === 'plan' ? '/skill:plan'
    : kind === 'audit' ? '/skill:audit'
    : kind === 'implement' ? '/skill:implement'
    : kind === 'risk-effort' ? '/skill:effort-and-risk'
    : kind === 'scheduled' ? 'scheduled prompt'
    : '/skill:intake';
  const suffix = title ? ` (${title.replace(/[\r\n]+/g, ' ')})` : '';
  return `Auto-dispatched by the herdr downtime worker at ${dispatchedAt} — running ${skill} ${itemId}${suffix}.`;
}
