/**
 * src/interview/explanation.ts — producer-review explanation: evidence
 * formatting, prompt construction, rendering, structured fallback and the
 * bounded LLM call.
 *
 * Responsibility: explain why `needsProducerReview` is set and what clears it,
 * using the LLM when available and structured evidence otherwise.
 *
 * Extracted verbatim from src/commands/interview.ts (WL-0MVXY379W000CE8J).
 */

import type { Comment, WorkItem } from '../types.js';
import type { ChatClient } from '../lib/llm.js';

/**
 * Instruction sent to the LLM when explaining the `needsProducerReview`
 * flag. The model must first state **why** the item is flagged (citing the
 * triggering evidence) and only then what the producer must do to clear it
 * (WL-0MUUAMP7M008Z4GK AC1).
 */
export const PRODUCER_REVIEW_INSTRUCTION =
  'Explain why the needsProducerReview flag is set, citing the triggering ' +
  'evidence (the latest audit verdict and summary, review or audit comments, ' +
  'or the item description), and then explain what the producer needs to do ' +
  'in order to remove the needsProducerReview flag';

/** Maximum size (bytes) of the item context embedded in the prompt. */
export const MAX_PROMPT_CONTEXT_BYTES = 8192;

/** Maximum bytes of the audit summary embedded in the explanation prompt. */
export const MAX_AUDIT_SUMMARY_BYTES = 2048;

/** Maximum bytes of the audit raw-output excerpt embedded in the prompt. */
export const MAX_AUDIT_RAW_OUTPUT_BYTES = 2048;

/** Maximum length (characters) of the rendered explanation. */
export const MAX_EXPLANATION_LENGTH = 8192;

/**
 * Maximum number of lines in the rendered explanation. The render keeps
 * intentional line breaks (AC3) but caps how many are surfaced so a runaway
 * LLM response cannot flood the console.
 */
export const MAX_EXPLANATION_LINES = 512;

/** Default timeout (ms) for the explanation LLM call. */
export const EXPLANATION_TIMEOUT_MS = 15000;

/**
 * The subset of a persisted audit result consumed by the explanation. This is
 * structurally compatible with `PersistentStore#getAuditResult`, so callers
 * pass the row returned by the store directly (WL-0MUUAMP7M008Z4GK AC2/AC4).
 */
export interface ProducerReviewAuditContext {
  /** Whether the latest audit judged the item ready to close. */
  readyToClose: boolean;
  /** ISO 8601 timestamp of the audit, when known. */
  auditedAt?: string | null;
  /** Human-readable audit summary, when present. */
  summary?: string | null;
  /** Machine-readable audit output, when present. */
  rawOutput?: string | null;
  /** Audit author/provenance, when known. */
  author?: string | null;
}

/**
 * Dependencies for {@link buildProducerReviewExplanation}. The chat client is
 * injected so callers (and tests) never make network calls implicitly.
 */
export interface ProducerReviewExplanationDeps {
  /** Newest-first comments for the item (`getCommentsForWorkItem` order). */
  comments: Comment[];
  /**
   * Latest persisted audit result, when one exists. Included as first-class
   * prompt context and as the primary structured fallback signal.
   */
  auditResult?: ProducerReviewAuditContext | null;
  /** Chat client to use; `null`/`undefined` disables the LLM path. */
  chatClient?: ChatClient | null;
  /** When true, skip the LLM entirely and use the structured fallback. */
  noLlm?: boolean;
  /** Per-call timeout override in milliseconds. */
  timeoutMs?: number;
}

/**
 * Render an explanation readably for the console: keep intentional line
 * breaks and short Markdown structure, but collapse runs of spaces/tabs and
 * repeated blank lines, then bound the result by a documented character
 * length and line count (WL-0MUUAMP7M008Z4GK AC3). Truncation is marked with
 * a trailing ellipsis line.
 */
export function renderExplanation(
  text: string,
  maxLength: number = MAX_EXPLANATION_LENGTH,
  maxLines: number = MAX_EXPLANATION_LINES,
): string {
  const source = (text ?? '').replace(/\r\n?/g, '\n');
  const collapsed: string[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.replace(/[ \t]+/g, ' ').replace(/\s+$/, '');
    // Collapse runs of blank lines to a single blank line.
    if (line === '' && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[0] === '') collapsed.shift();
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') collapsed.pop();

  const joined = collapsed.join('\n');
  const overLines = collapsed.length > maxLines;
  const overLength = joined.length > maxLength;
  const truncated = overLines || overLength;

  const kept = overLines
    ? collapsed.slice(0, Math.max(1, maxLines - 1))
    : collapsed;
  let result = kept.join('\n');
  // Reserve two characters for the newline + ellipsis appended below.
  const budget = truncated ? Math.max(1, maxLength - 2) : maxLength;
  if (result.length > budget) result = result.slice(0, budget);
  result = result.replace(/\s+$/, '');

  if (!truncated) return result;
  return result.length > 0 ? `${result}\n…` : '…';
}

/** First non-empty line of a comment body, trimmed. */
function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? '';
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a char. */
function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = text;
  while (result.length > 0 && Buffer.byteLength(result, 'utf8') > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Format an audit result for the explanation prompt: verdict, provenance,
 * summary and a bounded raw-output excerpt. The summary/raw output are
 * individually bounded so a single large audit cannot dominate the prompt.
 */
function formatAuditPromptContext(audit: ProducerReviewAuditContext): string {
  const lines = [
    `Verdict: ${audit.readyToClose ? 'ready to close' : 'not ready to close'}`,
    `Audited at: ${audit.auditedAt ?? 'unknown'}`,
    `Audit author: ${audit.author ?? 'unknown'}`,
  ];
  const summary = audit.summary?.trim();
  if (summary) {
    lines.push('Summary:', truncateBytes(summary, MAX_AUDIT_SUMMARY_BYTES));
  }
  const raw = audit.rawOutput?.trim();
  if (raw) {
    lines.push(
      'Raw output (excerpt):',
      truncateBytes(raw, MAX_AUDIT_RAW_OUTPUT_BYTES),
    );
  }
  return lines.join('\n');
}

/**
 * Build the LLM prompt: the fixed instruction plus item context — the latest
 * audit result, the description and the two most recent comments — bounded to
 * {@link MAX_PROMPT_CONTEXT_BYTES}.
 *
 * The audit block is placed before the description so it survives the overall
 * byte-bounded truncation even when the description is very large: the audit
 * verdict/summary is the single most informative signal for flagging
 * (WL-0MUUAMP7M008Z4GK AC2).
 */
export function buildExplanationPrompt(
  item: WorkItem,
  comments: Comment[],
  auditResult?: ProducerReviewAuditContext | null,
): string {
  const recent = comments
    .slice(0, 2)
    .map(c => `${c.author}: ${firstLine(c.comment)}`)
    .join('\n');
  const sections: string[] = [`Work item: ${item.id} — ${item.title}`];
  if (auditResult) {
    sections.push('', 'Latest audit result:', formatAuditPromptContext(auditResult));
  }
  sections.push(
    '',
    'Description:',
    item.description,
    '',
    'Most recent comments:',
    recent || '(none)',
  );
  const context = sections.join('\n');
  return `${PRODUCER_REVIEW_INSTRUCTION}.\n\n${truncateBytes(context, MAX_PROMPT_CONTEXT_BYTES)}`;
}

/** The generic, last-resort actionable line. */
function genericFallback(item: WorkItem): string {
  return (
    `No structured evidence found in the description, comments or audit result; ` +
    `review the item and clear the flag with \`wl reviewed ${item.id} false\` ` +
    `once the blocker is resolved.`
  );
}

/**
 * Structured fallback used when the LLM is unavailable/disabled.
 *
 * Reports the flag reason from structured signals first — the latest audit
 * verdict and summary, then a durable audit-gap waiver, then the two most
 * recent comments — and only falls back to the generic actionable line as a
 * last resort (WL-0MUUAMP7M008Z4GK AC4). Line breaks are preserved so the
 * caller can render multiple signals readably.
 */
export function buildFallbackExplanation(
  item: WorkItem,
  comments: Comment[],
  auditResult?: ProducerReviewAuditContext | null,
): string {
  if (auditResult) {
    const verdict = auditResult.readyToClose
      ? 'ready to close'
      : 'not ready to close';
    const attribution = auditResult.author ? ` (audited by ${auditResult.author})` : '';
    const lines = [`Latest audit verdict: ${verdict}${attribution}.`];
    if (auditResult.auditedAt) lines.push(`Audited at: ${auditResult.auditedAt}`);
    const summary = auditResult.summary?.trim();
    if (summary) lines.push(summary);
    return lines.join('\n');
  }

  const waiver = item.auditWaiver;
  const waiverReason = waiver?.reason?.trim();
  if (waiver && waiverReason) {
    const author = waiver.author ? ` by ${waiver.author}` : '';
    return `Audit gap waived${author}: ${waiverReason}`;
  }

  const recent = comments
    .slice(0, 2)
    .map(c => `${c.author}: ${firstLine(c.comment)}`)
    .filter(entry => entry.replace(/^[^:]*:\s*/, '').length > 0);
  if (recent.length > 0) return recent.join('\n');

  return genericFallback(item);
}

/**
 * Result of {@link buildProducerReviewExplanationResult}. `usedLlm` reports
 * whether the text came from the LLM (true) or the structured fallback
 * (false), so the caller can surface a brief fallback notice
 * (WL-0MUX2W8IN005RW66).
 */
export interface ProducerReviewExplanationResult {
  text: string;
  usedLlm: boolean;
}

/**
 * Produce the producer-review explanation **plus** a signal of whether the
 * LLM path was actually used.
 *
 * Behaves exactly like {@link buildProducerReviewExplanation} but returns
 * `{ text, usedLlm }` instead of a bare string: `usedLlm` is `false` when the
 * item is not flagged (result `null`), the LLM is disabled/unavailable, or
 * the request fails, times out or returns an empty response. The public
 * {@link buildProducerReviewExplanation} keeps its string contract and
 * delegates here, so existing callers are unaffected
 * (WL-0MUX2W8IN005RW66).
 */
export async function buildProducerReviewExplanationResult(
  item: WorkItem,
  deps: ProducerReviewExplanationDeps,
): Promise<ProducerReviewExplanationResult | null> {
  if (!item.needsProducerReview) return null;

  if (!deps.noLlm && deps.chatClient?.available) {
    try {
      const response = await deps.chatClient.complete(
        buildExplanationPrompt(item, deps.comments, deps.auditResult),
        { timeoutMs: deps.timeoutMs ?? EXPLANATION_TIMEOUT_MS },
      );
      const rendered = renderExplanation(response);
      if (rendered.length > 0) return { text: rendered, usedLlm: true };
    } catch {
      // Silent fallback — the explanation is advisory; never surface an error.
    }
  }

  return {
    text: renderExplanation(
      buildFallbackExplanation(item, deps.comments, deps.auditResult),
    ),
    usedLlm: false,
  };
}

/**
 * Produce a bounded, readable explanation of **why** the item requires
 * producer review and what clears the flag.
 *
 * Returns `null` when the item is not flagged. Otherwise it calls the injected
 * chat client (unless `noLlm` is set or the client is unavailable) and falls
 * back silently to the structured evidence — audit verdict/summary, waiver,
 * comments — on any failure (network error, non-2xx, timeout or empty
 * response). The explanation is advisory: it never mutates the item.
 */
export async function buildProducerReviewExplanation(
  item: WorkItem,
  deps: ProducerReviewExplanationDeps,
): Promise<string | null> {
  const result = await buildProducerReviewExplanationResult(item, deps);
  return result ? result.text : null;
}
