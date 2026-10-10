/**
 * Interview command - Interactive walkthrough of outstanding interview
 * questions on a work item, capturing responses and clearing the
 * producer review flag.
 *
 * The command walks the "Clarifying questions" appendix of a work item
 * description (written by the intake/plan skills), extracts outstanding
 * questions, prompts the producer for each answer, writes the answers back
 * into the description and clears `needsProducerReview`.
 *
 * Question detection is deliberately tolerant of the formats observed in
 * practice:
 *
 *   ## Appendix: Clarifying questions
 *   - Q: "Who is the primary user?" — Answer (user): "Support engineers".
 *     Source: interactive reply.
 *
 * as well as the legacy numbered form:
 *
 *   1. **Q: What is the escape hatch?**
 *      **A: Documented in the runbook.**
 *
 * Answers are written back in place so surrounding markup (Source lines,
 * attribution, quotes) is preserved losslessly.
 *
 * When the item is flagged for producer review but there is nothing to
 * interview (no section, or no parseable questions), the command explains
 * **why** it is flagged — drawing on the persisted audit result, the review
 * comments and the description — and then offers to clear the flag. The
 * explanation is produced by the local LLM when available and silently falls
 * back to the structured evidence otherwise; it is advisory and never mutates
 * the item (WL-0MUUAMP7M008Z4GK).
 *
 * Multi-second LLM requests are made visible: the command prints a static
 * `Thinking…` status (plus a TTY-only spinner) before each request and clears
 * it before any subsequent output or prompt, suppressing all feedback in
 * `--json` mode. When a request is unavailable, times out or errors and the
 * command falls back to structured evidence, it prints a brief
 * `LLM unavailable — using structured evidence.` notice
 * (WL-0MUX2W8IN005RW66).
 *
 * When the item is **not** flagged (or before explaining) and the operator
 * opts in with `--llm` or `interview.intelligent: true`, the command falls
 * back to the local LLM to extract questions from natural prose when the
 * deterministic parser finds none. Extracted questions are confirmed one by
 * one through the same prompt loop and only confirmed answers are written
 * back through the deterministic re-serialiser; an unavailable/failing LLM
 * degrades to the deterministic-only behaviour (after the same brief
 * fallback notice) (WL-0MUH7ACKJ0024VGF, WL-0MUX2W8IN005RW66).
 *
 * WL-0MU55UDBJ008DJ67
 */

import type { PluginContext } from '../plugin-types.js';
import { withStoreMutationLock } from '../mutation-lock.js';
import type { InterviewOptions } from '../cli-types.js';
import type { WorkItem, Comment } from '../types.js';
import { OpenAIChatClient, type ChatClient } from '../lib/llm.js';
import {
  startLlmProgress,
  LLM_FALLBACK_NOTICE,
  type LlmProgressHandle,
  type ProgressWriteStream,
} from '../lib/progress-feedback.js';
import {
  resolveLlmConfig,
  isIntelligentInterviewEnabled,
} from '../config.js';
import * as readline from 'readline';

// ── Section markers ──────────────────────────────────────────────────────

/**
 * Matches the clarifying-questions appendix heading in its many variants:
 * `## Clarifying Questions & Answers`, `## Appendix: Clarifying questions`,
 * `# Appendix: Clarifying Questions`, etc.
 */
const SECTION_HEADER_RE =
  /^(#{1,6})\s+(?:Appendix:\s*)?Clarifying\s+Questions?(?:\s*(?:&|and)\s*Answers?)?\s*$/i;
const NEXT_SECTION_RE = /^#{1,6}\s+/;

/**
 * An answer that shares the question line, separated by an em/en dash:
 * ` — Answer (user): "..."` or ` — **Answer:** ...`.
 */
const INLINE_ANSWER_RE =
  /\s*[—–-]\s*\*{0,2}(?:Answer|A)(?!\w)\*{0,2}(?:\s*\(([^)]*)\))?\s*:\*{0,2}\s*([\s\S]*)$/i;

/**
 * An answer on its own line, optionally introduced by a dash:
 * `  **Answer (user):** ...` or `  — **Answer:** ...`.
 */
const ANSWER_LINE_RE =
  /^(\s*)[—–-]?\s*\*{0,2}(?:Answer|A)(?!\w)\*{0,2}(?:\s*\(([^)]*)\))?\s*:\*{0,2}\s*([\s\S]*)$/i;

/** An explicit "awaiting producer" placeholder. */
const PLACEHOLDER_RE = /^\*{0,2}\(?\s*awaiting producer\s*\)?\*{0,2}/i;
/**
 * An explicit "OPEN QUESTION" placeholder used by the intake/plan skills
 * to mark a question that the producer has not yet answered, e.g.
 * `— **OPEN QUESTION**, context: ...`.
 */
const OPEN_QUESTION_RE = /^\*{0,2}\(?OPEN\s+QUESTION\)?\*{0,2}/i;
/**
 * An inline `— **OPEN QUESTION**` answer marker on a continuation line,
 * capturing the placeholder token itself in group 1.
 */
const INLINE_OPEN_QUESTION_RE =
  /\s*[—–-]\s*(\*{0,2}\(?OPEN\s+QUESTION\)?\*{0,2})/i;
/** A "TBD" answer is treated as outstanding. */
const TBD_RE = /^\*{0,2}(?:tbd|to be determined)\b/i;
/** Trailing attribution metadata that shares the answer line. */
const META_TAIL_RE = /\s+\*{0,2}(?:Source|Final)\*{0,2}\s*:/i;
/** Scaffold appended when a question has no answer marker at all. */
const INSERT_WRAPPER = '\n  **Answer (producer):** ';

// ── Section extraction ───────────────────────────────────────────────────

/**
 * The clarifying-questions section of a work item description.
 */
export interface ClarifyingSection {
  header: string;
  content: string;
  start: number;
  end: number;
}

/**
 * Extract the clarifying-questions section from a work item description.
 * Returns `{ header, content, start, end }` where `content` is the body
 * after the header (up to the next Markdown heading), or `null` when no
 * recognised heading is present.
 */
export function extractClarifyingSection(
  description: string,
): ClarifyingSection | null {
  const lines = description.split('\n');
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    if (SECTION_HEADER_RE.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (NEXT_SECTION_RE.test(lines[i])) {
      end = i;
      break;
    }
  }

  const content = lines.slice(start + 1, end).join('\n');
  return { header: lines[start], content, start, end };
}

// ── Q/A parsing ──────────────────────────────────────────────────────────

/**
 * A parsed clarifying question/answer pair.
 *
 * `before` and `after` bracket the answer value within the section content
 * so that rebuilding is lossless: `before + answer + after` reproduces the
 * original text when `answer` is unchanged.
 */
export interface ClarifyingQAPair {
  number: number;
  question: string;
  answer: string;
  unanswered: boolean;
  startLine: number;
  endLine: number;
  before: string;
  after: string;
  /**
   * True when the question had no answer marker, so an answer scaffold is
   * inserted only once the producer actually answers.
   */
  needsScaffold: boolean;
}

interface AnswerRegion {
  start: number;
  end: number;
  value: string;
  unanswered: boolean;
  hasMarker: boolean;
}

/** Collapse a raw question fragment into a single clean line. */
function cleanQuestion(raw: string): string {
  let text = (raw ?? '').replace(/\s+/g, ' ').trim();
  // Strip paired bold/quote decoration (Q markers are frequently wrapped
  // around the whole question, e.g. `**Q1: ...?**`).
  for (let i = 0; i < 2; i++) {
    text = text.replace(/^\*+/, '').replace(/\*+$/, '').trim();
    text = text.replace(/^"+/, '').replace(/"+$/, '').trim();
  }
  return text;
}

/** Result of recognising a question-start line. */
interface QuestionStart {
  number?: number;
  remainder: string;
  remainderStart: number;
}

/**
 * Recognise a question-start line and return the question text after the
 * marker. Supports numbered lists (`1. **Q:**`), bullets (`- **Q:**`,
 * `- Q: "..."`), bare `**Q**:` lines, optional inline numbering (`Q1` or
 * `Q1.`), and `(qualifier)` / `— qualifier` forms.
 */
function parseQuestionStart(
  line: string,
  lineOffset: number,
): QuestionStart | null {
  let pos = 0;
  const indent = line.match(/^\s*/)?.[0] ?? '';
  pos += indent.length;
  let rest = line.slice(indent.length);

  let number: number | undefined;

  const bullet = rest.match(/^(?:(\d+)[.)]|[-*])\s+/);
  if (bullet) {
    if (bullet[1]) number = parseInt(bullet[1], 10);
    pos += bullet[0].length;
    rest = rest.slice(bullet[0].length);
  }

  const bold = rest.match(/^\*{1,2}/);
  if (bold) {
    pos += bold[0].length;
    rest = rest.slice(bold[0].length);
  }

  if (!/^Q/i.test(rest)) return null;
  pos += 1;
  rest = rest.slice(1);

  const digits = rest.match(/^(\d+)/);
  if (digits) {
    number = parseInt(digits[1], 10);
    pos += digits[1].length;
    rest = rest.slice(digits[1].length);
  }

  // The marker must be followed by a delimiter so prose words beginning
  // with "Q" (e.g. "Quality:", "Question:") are not mistaken for markers.
  if (!/^[\s:*()\-—–]|$/.test(rest)) return null;

  const paren = rest.match(/^\s*\([^)]*\)/);
  if (paren) {
    pos += paren[0].length;
    rest = rest.slice(paren[0].length);
  }
  const dash = rest.match(/^\s*[—–-]\s*[^*:]+?(?=\*{0,2}\s*:)/);
  if (dash) {
    pos += dash[0].length;
    rest = rest.slice(dash[0].length);
  }
  const close = rest.match(/^\s*\*{0,2}\s*:?\s*\*{0,2}\s?/);
  if (close) {
    pos += close[0].length;
    rest = rest.slice(close[0].length);
  }

  return { number, remainder: rest, remainderStart: lineOffset + pos };
}

/**
 * Locate the answer value inside a raw answer region and decide whether it
 * is outstanding. Offsets are absolute within `content`; everything outside
 * `[start, end)` (quotes, bold markers, attribution) is preserved verbatim.
 */
function computeAnswerRegion(
  content: string,
  rawStart: number,
  rawEnd: number,
): AnswerRegion {
  let s = rawStart;
  let e = rawEnd;
  const isWs = (ch: string) =>
    ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

  while (s < e && isWs(content[s])) s++;
  while (e > s && isWs(content[e - 1])) e--;

  if (s >= e) {
    return { start: s, end: s, value: '', unanswered: true, hasMarker: true };
  }

  // Detect placeholders before stripping bold markers so the whole token is
  // replaced when the producer answers.
  const raw = content.slice(s, e);
  const placeholder = raw.match(PLACEHOLDER_RE) ?? raw.match(OPEN_QUESTION_RE);
  if (placeholder) {
    return {
      start: s,
      end: s + placeholder[0].length,
      value: placeholder[0],
      unanswered: true,
      hasMarker: true,
    };
  }
  if (TBD_RE.test(raw)) {
    return { start: s, end: e, value: raw, unanswered: true, hasMarker: true };
  }

  // Bold markers are formatting, not content.
  while (s < e && content[s] === '*') s++;
  while (e > s && content[e - 1] === '*') e--;

  // Strip surrounding quotes.
  if (s < e && content[s] === '"') {
    const closing = content.indexOf('"', s + 1);
    if (closing !== -1 && closing < e) {
      s += 1;
      e = closing;
    } else {
      s += 1;
    }
  }

  // Placeholders/TBD may sit inside quotes.
  const inner = content.slice(s, e);
  const innerPlaceholder =
    inner.match(PLACEHOLDER_RE) ?? inner.match(OPEN_QUESTION_RE);
  if (innerPlaceholder) {
    return {
      start: s,
      end: s + innerPlaceholder[0].length,
      value: innerPlaceholder[0],
      unanswered: true,
      hasMarker: true,
    };
  }
  if (TBD_RE.test(inner)) {
    return { start: s, end: e, value: inner, unanswered: true, hasMarker: true };
  }

  // Drop trailing "Source:"/"Final:" metadata that shares the answer line.
  const meta = content.slice(s, e).search(META_TAIL_RE);
  if (meta >= 0) {
    e = s + meta;
    while (e > s && (content[e - 1] === ' ' || content[e - 1] === '\t')) e--;
  }

  const value = content.slice(s, e).trim();
  return { start: s, end: e, value, unanswered: value === '', hasMarker: true };
}

/**
 * Parse Q/A pairs from the clarifying section content.
 *
 * Returns every question found (answered and outstanding). Line/offset
 * information is retained so answers can be written back losslessly.
 */
export function parseQAPairs(content: string): ClarifyingQAPair[] {
  const lines = content.split('\n');
  const lineStart: number[] = [];
  {
    let offset = 0;
    for (const line of lines) {
      lineStart.push(offset);
      offset += line.length + 1;
    }
  }
  const contentLen = content.length;

  interface Start {
    line: number;
    number: number;
    remainder: string;
    remainderStart: number;
  }

  const starts: Start[] = [];
  let counter = 0;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseQuestionStart(lines[i], lineStart[i]);
    if (!parsed) continue;
    counter += 1;
    starts.push({
      line: i,
      number: parsed.number ?? counter,
      remainder: parsed.remainder,
      remainderStart: parsed.remainderStart,
    });
  }
  if (starts.length === 0) return [];

  const pairs: ClarifyingQAPair[] = [];
  for (let idx = 0; idx < starts.length; idx++) {
    const cur = starts[idx];
    const sliceStart = idx === 0 ? 0 : lineStart[cur.line];
    const sliceEnd =
      idx === starts.length - 1 ? contentLen : lineStart[starts[idx + 1].line];

    let question: string;
    let region: AnswerRegion;
    let answerLine = cur.line;

    const inline = cur.remainder.match(INLINE_ANSWER_RE);
    const inlineOpen = inline ? null : cur.remainder.match(INLINE_OPEN_QUESTION_RE);
    if (inline || inlineOpen) {
      const isOpen = !inline;
      const match = (inline ?? inlineOpen)!;
      const markerIdx = match.index ?? 0;
      const markerLen = match[0].length;
      const placeholder = isOpen ? (match[1] ?? '') : '';
      const tail = isOpen ? '' : (match[2] ?? '');
      question = cleanQuestion(cur.remainder.slice(0, markerIdx));
      const rawStart =
        cur.remainderStart +
        markerIdx +
        markerLen -
        (isOpen ? placeholder.length : tail.length);
      const rawEnd = cur.remainderStart + markerIdx + markerLen;
      region = computeAnswerRegion(content, rawStart, rawEnd);
    } else {
      let found: {
        line: number;
        start: number;
        end: number;
        before: string;
      } | null = null;
      for (
        let j = cur.line + 1;
        j < lines.length && lineStart[j] < sliceEnd;
        j++
      ) {
        const am = lines[j].match(ANSWER_LINE_RE);
        if (am) {
          const tail = am[3] ?? '';
          found = {
            line: j,
            start: lineStart[j] + am[0].length - tail.length,
            end: lineStart[j] + am[0].length,
            before: '',
          };
          break;
        }
        // An answer may also trail a continuation of the question on the
        // same line (e.g. `... cleanup, or split? — **Answer:** ...`).
        const im = lines[j].match(INLINE_ANSWER_RE);
        if (im) {
          const tail = im[2] ?? '';
          const idx = im.index ?? 0;
          found = {
            line: j,
            start: lineStart[j] + idx + im[0].length - tail.length,
            end: lineStart[j] + idx + im[0].length,
            before: lines[j].slice(0, idx),
          };
          break;
        }
        // An unresolved question uses an inline `— **OPEN QUESTION**`
        // placeholder, which may sit on a continuation line.
        const om = lines[j].match(INLINE_OPEN_QUESTION_RE);
        if (om) {
          const placeholder = om[1] ?? '';
          const idx = om.index ?? 0;
          found = {
            line: j,
            start: lineStart[j] + idx + om[0].length - placeholder.length,
            end: lineStart[j] + idx + om[0].length,
            before: lines[j].slice(0, idx),
          };
          break;
        }
      }

      if (found) {
        const preceding = lines.slice(cur.line + 1, found.line);
        const continuation = [...preceding, found.before].join(' ');
        question = cleanQuestion(`${cur.remainder} ${continuation}`);
        region = computeAnswerRegion(content, found.start, found.end);
        answerLine = found.line;
      } else {
        // No answer marker: treat every line up to the next question as part
        // of the question so multi-line questions are not truncated.
        const endLine =
          idx + 1 < starts.length ? starts[idx + 1].line : lines.length;
        const continuation = lines.slice(cur.line + 1, endLine).join(' ');
        question = cleanQuestion(`${cur.remainder} ${continuation}`);
        region = {
          start: sliceEnd,
          end: sliceEnd,
          value: '',
          unanswered: true,
          hasMarker: false,
        };
      }
    }

    let before: string;
    let after: string;
    if (region.hasMarker) {
      before = content.slice(sliceStart, region.start);
      after = content.slice(region.end, sliceEnd);
    } else {
      // No answer marker: keep the text exact and insert the scaffold only
      // when an answer is actually recorded (see `rebuildQAPairs`).
      before = content.slice(sliceStart, sliceEnd);
      after = '';
    }

    pairs.push({
      number: cur.number,
      question,
      answer: region.value,
      unanswered: region.unanswered,
      startLine: cur.line,
      endLine: Math.max(cur.line, answerLine),
      before,
      after,
      needsScaffold: !region.hasMarker,
    });
  }

  return pairs;
}

/**
 * Rebuild the clarifying section content from Q/A pairs. Lossless when
 * answers are unchanged; when an answer is replaced, only the answer value
 * is rewritten and surrounding markup is preserved.
 */
export function rebuildQAPairs(pairs: ClarifyingQAPair[]): string {
  return pairs
    .map(
      p =>
        p.before +
        (p.needsScaffold && !p.unanswered ? INSERT_WRAPPER : '') +
        p.answer +
        p.after,
    )
    .join('');
}

/**
 * Rebuild the full description with the updated clarifying section.
 */
export function rebuildDescription(
  description: string,
  section: ReturnType<typeof extractClarifyingSection>,
  newContent: string,
): string {
  if (!section) return description;

  const lines = description.split('\n');
  const before = lines.slice(0, section.start + 1); // header line
  const after = lines.slice(section.end); // next section or end

  return [...before, newContent, ...after].join('\n').trim();
}

// ── Producer-review explanation ─────────────────────────────────────────

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

// ── LLM-assisted question extraction ─────────────────────────────────────

/**
 * Instruction sent to the LLM when the deterministic parser finds no
 * clarifying questions. The model must return **only** a JSON array of
 * `{ question }` objects (or `[]`) so the response can be parsed defensively
 * and every entry confirmed by the operator before anything is written
 * (WL-0MUH7ACKJ0024VGF AC2/AC3/AC4).
 */
export const EXTRACTION_INSTRUCTION =
  'Extract every unanswered clarifying question from the work item ' +
  'description below. Respond with ONLY a JSON array of objects of the ' +
  'form [{"question": "..."}] and nothing else. If there are no clarifying ' +
  'questions, respond with []. Do not include answered questions, ' +
  'commentary, or markdown code fences.';

/** Maximum size (bytes) of the description sent to the extraction LLM. */
export const MAX_EXTRACTION_DESCRIPTION_BYTES = 8192;

/** Default timeout (ms) for the extraction LLM call. */
export const EXTRACTION_TIMEOUT_MS = 15000;

/**
 * Build the bounded extraction prompt: the fixed instruction plus the
 * description source truncated to {@link MAX_EXTRACTION_DESCRIPTION_BYTES}.
 * Callers pass the clarifying-section body when one is present (and
 * non-empty), otherwise the whole description.
 */
export function buildExtractionPrompt(description: string): string {
  return (
    `${EXTRACTION_INSTRUCTION}\n\n` +
    `Description:\n${truncateBytes(description, MAX_EXTRACTION_DESCRIPTION_BYTES)}`
  );
}

/**
 * Defensively parse an LLM extraction response into a de-duplicated list of
 * question strings.
 *
 * Non-JSON text, a non-array payload, malformed entries and blank questions
 * are all treated as "no questions" and never throw (WL-0MUH7ACKJ0024VGF
 * AC: parse defensively). A leading/trailing markdown code fence or
 * surrounding prose is tolerated.
 */
export function parseExtractedQuestions(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  let text = raw.trim();
  if (text === '') return [];

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && typeof fence[1] === 'string') text = fence[1].trim();

  if (!text.startsWith('[')) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    text = text.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const questions: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const question = (entry as { question?: unknown }).question;
    if (typeof question !== 'string') continue;
    const cleaned = question.replace(/\s+/g, ' ').trim();
    if (cleaned === '' || seen.has(cleaned)) continue;
    seen.add(cleaned);
    questions.push(cleaned);
  }
  return questions;
}

/**
 * Result of {@link tryExtractQuestionsWithLlm}. `usedLlm` reports whether the
 * request actually completed (true, even when it returned no questions) or
 * failed/was skipped (false), so the caller can surface a fallback notice
 * (WL-0MUX2W8IN005RW66).
 */
export interface LlmExtractionResult {
  questions: string[];
  usedLlm: boolean;
}

/**
 * Ask the chat client to extract clarifying questions from `description`,
 * reporting whether the LLM path was actually used.
 *
 * Never throws: an unavailable client, a failed/timed-out request or a
 * malformed response all resolve to `{ questions: [], usedLlm: false }`.
 * Callers then fall back to the deterministic-only behaviour
 * (WL-0MUH7ACKJ0024VGF AC5).
 */
export async function tryExtractQuestionsWithLlm(
  chatClient: ChatClient | null | undefined,
  description: string,
  timeoutMs: number = EXTRACTION_TIMEOUT_MS,
): Promise<LlmExtractionResult> {
  if (!chatClient?.available) return { questions: [], usedLlm: false };
  try {
    const raw = await chatClient.complete(buildExtractionPrompt(description), {
      timeoutMs,
    });
    return { questions: parseExtractedQuestions(raw), usedLlm: true };
  } catch {
    return { questions: [], usedLlm: false };
  }
}

/**
 * Ask the chat client to extract clarifying questions from `description`.
 * Returns `[]` (never throws) when the client is unavailable, the request
 * fails, times out or the response is malformed — callers then fall back
 * silently to the deterministic-only behaviour (WL-0MUH7ACKJ0024VGF AC5).
 */
export async function extractQuestionsWithLlm(
  chatClient: ChatClient | null | undefined,
  description: string,
  timeoutMs: number = EXTRACTION_TIMEOUT_MS,
): Promise<string[]> {
  const result = await tryExtractQuestionsWithLlm(
    chatClient,
    description,
    timeoutMs,
  );
  return result.questions;
}

/**
 * Build lossless clarifying-Q/A pairs for LLM-extracted questions so that
 * confirmed answers are written back through the deterministic re-serialiser
 * ({@link rebuildQAPairs} / {@link rebuildDescription}) rather than from raw
 * model output (WL-0MUH7ACKJ0024VGF AC4).
 */
export function buildExtractedPairs(questions: string[]): ClarifyingQAPair[] {
  return questions.map((question, index) => ({
    number: index + 1,
    question,
    answer: '',
    unanswered: true,
    startLine: 0,
    endLine: 0,
    before: `- Q: ${question} — Answer (producer): `,
    after: '\n',
    needsScaffold: false,
  }));
}

/** Canonical heading used when the description has no clarifying section. */
export const EXTRACTED_SECTION_HEADER = '## Appendix: Clarifying questions';

/** Append a clarifying section to a description that has none. */
export function insertClarifyingSection(
  description: string,
  content: string,
): string {
  const base = description.replace(/\s+$/, '');
  const body = content.replace(/\s+$/, '');
  if (base.length === 0) return `${EXTRACTED_SECTION_HEADER}\n\n${body}`;
  return `${base}\n\n${EXTRACTED_SECTION_HEADER}\n\n${body}`;
}

/** Merge new extracted pairs into an existing (question-free) section body. */
function mergeExtractedIntoSection(existing: string, content: string): string {
  const base = existing.replace(/\s+$/, '');
  const body = content.replace(/\s+$/, '');
  if (base.length === 0) return body;
  if (body.length === 0) return base;
  return `${base}\n${body}`;
}

// ── Core interview loop ──────────────────────────────────────────────────

/** Minimal database dependency required by {@link runInterview}. */
export interface InterviewStore {
  update: (id: string, updates: Partial<WorkItem>) => unknown;
}

/** Injectable input/output used by {@link runInterview}. */
export interface InterviewIO {
  prompt: (message: string) => Promise<string>;
}

/** Outcome of an interview walkthrough. */
export interface InterviewOutcome {
  noSection: boolean;
  noQuestions: boolean;
  recorded: number;
  total: number;
  outstanding: number;
  allAnswered: boolean;
  /** Number of questions extracted by the LLM fallback (0 when unused). */
  extracted: number;
}

/** Options controlling the LLM-assisted question-extraction fallback. */
export interface InterviewRunOptions {
  /** Enable LLM extraction when the deterministic parser finds no questions. */
  llmFallback?: boolean;
  /** Chat client for extraction; `null`/`undefined` disables the path. */
  chatClient?: ChatClient | null;
  /** Per-call timeout override for the extraction request (ms). */
  timeoutMs?: number;
  /**
   * Called immediately before the extraction request is issued, so callers
   * can show in-flight progress feedback (WL-0MUX2W8IN005RW66).
   */
  onLlmStart?: () => void;
  /**
   * Called once the extraction request has settled. `usedLlm` is true when
   * the request completed (even if it returned no questions); false when it
   * was skipped, failed or timed out — callers use this to surface a fallback
   * notice (WL-0MUX2W8IN005RW66).
   */
  onLlmSettled?: (result: { usedLlm: boolean }) => void;
}

/** A zeroed outcome; `extracted` is always present. */
function emptyOutcome(): InterviewOutcome {
  return {
    noSection: false,
    noQuestions: false,
    recorded: 0,
    total: 0,
    outstanding: 0,
    allAnswered: false,
    extracted: 0,
  };
}

/**
 * Prompt for and persist answers to `pairs`.
 *
 * On the deterministic path (`fromExtraction === false`) the whole section is
 * rebuilt losslessly on every answer, exactly as before. On the LLM-extracted
 * path only questions the operator actually answers (confirms) are written
 * back — skipped questions are dropped — and the write-back always goes
 * through {@link rebuildQAPairs} / {@link rebuildDescription}, inserting the
 * canonical section header when the description had none.
 */
async function walkQuestions(
  item: WorkItem,
  store: InterviewStore,
  io: InterviewIO,
  section: ClarifyingSection | null,
  pairs: ClarifyingQAPair[],
  fromExtraction: boolean,
): Promise<InterviewOutcome> {
  const outcome = emptyOutcome();
  outcome.total = pairs.length;
  outcome.extracted = fromExtraction ? pairs.length : 0;

  const unanswered = pairs.filter(p => p.unanswered);
  if (unanswered.length === 0) {
    if (item.needsProducerReview) {
      store.update(item.id, { needsProducerReview: false });
    }
    outcome.allAnswered = true;
    return outcome;
  }

  let recorded = 0;
  let interrupted = false;
  const confirmed: ClarifyingQAPair[] = [];

  for (const pair of unanswered) {
    const answer = await io.prompt(`${pair.number}. ${pair.question}\n   →`);
    const cleaned = answer.replace(/\s+/g, ' ').trim();
    if (cleaned === '') {
      // EOF / empty response — session interrupted; stop asking.
      interrupted = true;
      break;
    }

    pair.answer = cleaned;
    pair.unanswered = false;
    recorded += 1;

    let newDescription: string;
    if (fromExtraction) {
      confirmed.push(pair);
      const newContent = rebuildQAPairs(confirmed);
      newDescription = section
        ? rebuildDescription(
            item.description,
            section,
            mergeExtractedIntoSection(section.content, newContent),
          )
        : insertClarifyingSection(item.description, newContent);
    } else {
      const newContent = rebuildQAPairs(pairs);
      newDescription = rebuildDescription(item.description, section, newContent);
    }
    store.update(item.id, { description: newDescription });
  }

  const allAnswered = !interrupted && pairs.every(p => !p.unanswered);
  if (allAnswered) {
    store.update(item.id, { needsProducerReview: false });
  }

  outcome.recorded = recorded;
  outcome.outstanding = pairs.filter(p => p.unanswered).length;
  outcome.allAnswered = allAnswered;
  return outcome;
}

/**
 * Walk the outstanding questions on `item`, prompting via `io` and writing
 * each answer back to the description as it is given.
 *
 * Answers are persisted after each response so an interrupted session can be
 * resumed; the producer review flag is only cleared once every question has
 * a non-empty answer (the `allAnswered` auto-clear path, unchanged).
 *
 * When the deterministic parser finds no questions and the caller enables the
 * LLM fallback (`options.llmFallback` + an available `chatClient`),
 * {@link extractQuestionsWithLlm} is asked for a bounded JSON array of
 * questions; each is then presented through the same prompt loop for
 * confirmation and answer. Extraction failures degrade silently to the
 * deterministic-only outcome (WL-0MUH7ACKJ0024VGF AC1–AC6).
 *
 * The "no questions detected" edge case (noSection / noQuestions) is handled
 * by the command registration below, which explains how the producer clears
 * an outstanding `needsProducerReview` flag and offers to clear it: see
 * {@link buildProducerReviewExplanation} and `.option('--no-llm')`.
 */
export async function runInterview(
  item: WorkItem,
  store: InterviewStore,
  io: InterviewIO,
  options: InterviewRunOptions = {},
): Promise<InterviewOutcome> {
  const section = extractClarifyingSection(item.description);
  const pairs = section ? parseQAPairs(section.content) : [];

  // Deterministic questions always win — the LLM is never called then.
  if (pairs.length > 0) {
    return walkQuestions(item, store, io, section, pairs, false);
  }

  // No parseable questions → optional LLM-assisted extraction fallback.
  if (options.llmFallback && options.chatClient?.available) {
    // Prefer the clarifying-section body when one is present and non-empty;
    // otherwise scan the whole description (WL-0MUQ0VQ8A002HHFA).
    const source =
      section && section.content.trim() !== ''
        ? section.content
        : item.description;
    // Notify the caller so it can show progress feedback around the request,
    // and always report back whether the LLM path was actually used — even if
    // the request unexpectedly throws (WL-0MUX2W8IN005RW66).
    options.onLlmStart?.();
    let usedLlm = false;
    let questions: string[] = [];
    try {
      const extraction = await tryExtractQuestionsWithLlm(
        options.chatClient,
        source,
        options.timeoutMs,
      );
      usedLlm = extraction.usedLlm;
      questions = extraction.questions;
    } finally {
      options.onLlmSettled?.({ usedLlm });
    }
    if (questions.length > 0) {
      const extractedPairs = buildExtractedPairs(questions);
      return walkQuestions(item, store, io, section, extractedPairs, true);
    }
  }

  return {
    ...emptyOutcome(),
    noSection: section === null,
    noQuestions: section !== null,
  };
}

// ── Interactive input ────────────────────────────────────────────────────

/**
 * Interactive input via a single readline interface driven by its async
 * iterator. This drains piped stdin line-by-line (a raw `stdin.once('data')`
 * consumer would swallow a multi-line piped chunk as a single answer and
 * hang on EOF), and does not lose the interface between questions (per-
 * prompt interfaces throw ERR_USE_AFTER_CLOSE once the stream ends). On EOF
 * mid-session the loop ends, so an interrupted/piped session degrades
 * gracefully — already-recorded answers are still persisted.
 */
function createPromptLoop(): {
  next: (message: string) => Promise<string>;
  close: () => void;
} {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const iterator = rl[Symbol.asyncIterator]();
  return {
    next: async (message: string) => {
      process.stdout.write(message + ' ');
      const { value, done } = await iterator.next();
      if (done) return '';
      return String(value ?? '').trim();
    },
    close: () => rl.close(),
  };
}

// ── Command registration ─────────────────────────────────────────────────

/** The shape returned by {@link createPromptLoop} — one shared iterator. */
export interface InterviewPromptLoop {
  next: (message: string) => Promise<string>;
  close: () => void;
}

/** Injectable dependencies for the interview command (used by tests). */
export interface InterviewCommandDeps {
  /**
   * Build the chat client used for the producer-review explanation and the
   * LLM-assisted question extraction. Return `null` to disable the LLM path.
   * Defaults to an `OpenAIChatClient` over the resolved LLM config.
   */
  chatClientFactory?: (options: { model?: string }) => ChatClient | null;
  /**
   * Create the interactive prompt loop. Overridable so tests never open a
   * real readline interface (mirrors the {@link InterviewIO} pattern).
   */
  promptLoopFactory?: () => InterviewPromptLoop;
  /**
   * Confirm whether the `needsProducerReview` flag should be cleared.
   * Defaults to a `readline` `(y/N)` prompt on stdin/stdout.
   */
  clearPrompt?: (message: string) => Promise<boolean>;
  /**
   * Sink for in-flight LLM progress feedback (defaults to `process.stdout`).
   * Tests inject a capturing stream to assert the status message, spinner and
   * fallback notice without writing to the real terminal
   * (WL-0MUX2W8IN005RW66).
   */
  progressOutStream?: ProgressWriteStream;
}

/**
 * Ask a yes/no question on the terminal, defaulting to **No** on anything
 * other than an explicit `y`/`yes` (parent AC1/AC3).
 */
export async function defaultClearPrompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>(resolve => {
      rl.question(message, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Whether the operator explicitly passed `--llm`.
 *
 * Commander stores `--llm` and `--no-llm` on the same `llm` key whose default
 * is `true`, so the only reliable signal is the option source. When running
 * under Commander, `getOptionValueSource('llm') === 'cli'` means the operator
 * set it (and `options.llm !== false` distinguishes `--llm` from `--no-llm`).
 * The in-process test harness invokes the action without a Commander command
 * and reports only an explicit `--llm` as `options.llm === true`.
 */
function isExplicitLlmRequested(
  options: InterviewOptions,
  command?: { getOptionValueSource?: (name: string) => string },
): boolean {
  if (command && typeof command.getOptionValueSource === 'function') {
    return (
      command.getOptionValueSource('llm') === 'cli' && options.llm !== false
    );
  }
  return options.llm === true;
}

export default function register(
  ctx: PluginContext,
  deps: InterviewCommandDeps = {},
): void {
  const { program, output, utils } = ctx;

  const chatClientFactory =
    deps.chatClientFactory ??
    ((options: { model?: string }): ChatClient => {
      const config = utils.getConfig();
      return new OpenAIChatClient({
        ...(config ? resolveLlmConfig(config) ?? {} : {}),
        hasExplicitConfig: true,
        ...(options.model ? { model: options.model } : {}),
      });
    });

  const promptLoopFactory = deps.promptLoopFactory ?? createPromptLoop;
  const clearPrompt = deps.clearPrompt ?? defaultClearPrompt;
  const progressStream: ProgressWriteStream =
    deps.progressOutStream ?? process.stdout;

  program
    .command('interview <id>')
    .description(
      'Walk through outstanding interview questions on a work item interactively, capturing answers and clearing the producer review flag',
    )
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--json', 'Non-interactive JSON output (no prompts, no mutation)')
    .option('--no-llm', 'Disable all LLM use (explanation and question extraction)')
    .option(
      '--llm',
      'Enable LLM-assisted clarifying-question extraction when the deterministic parser finds none',
    )
    .option('--model <model>', 'Override the chat model for the explanation')
    .action(async (
      id: string,
      options: InterviewOptions,
      command?: { getOptionValueSource?: (name: string) => string },
    ) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);

      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const item: WorkItem | null = db.get(normalizedId);
      if (!item) {
        output.error(`Work item not found: ${normalizedId}`, {
          success: false,
          error: 'work-item-not-found',
        });
        process.exit(1);
      }

      const jsonMode = options.json === true || utils.isJsonMode();
      // Commander maps `--no-llm` to `options.llm === false`; the test harness
      // passes the kebab-cased `noLlm`. Accept either spelling.
      const noLlm = options.noLlm === true || options.llm === false;

      // Enablement for LLM question extraction: explicit `--llm` (highest
      // priority) or the `interview.intelligent: true` config opt-in;
      // `--no-llm` disables all LLM use. Provider settings come from `llm.*`.
      const config = utils.getConfig();
      const intelligent = isIntelligentInterviewEnabled(config);
      const llmFallbackEnabled =
        !noLlm && (isExplicitLlmRequested(options, command) || intelligent);
      const chatClient = noLlm
        ? null
        : chatClientFactory({ model: options.model });

      const section = extractClarifyingSection(item.description);
      const pairs = section ? parseQAPairs(section.content) : [];
      const noSection = section === null;
      const noQuestions = section !== null && pairs.length === 0;
      const outstanding = pairs.filter(p => p.unanswered).length;
      const allAnswered = !noSection && !noQuestions && outstanding === 0;

      // ── LLM progress feedback (WL-0MUX2W8IN005RW66) ──────────────────
      // A static "Thinking…" status plus a TTY-only spinner is shown around
      // every LLM request; the fallback notice is printed once when the LLM
      // is unavailable or a request fails and structured evidence is used.
      let activeProgress: LlmProgressHandle | null = null;
      let fallbackNoticeEmitted = false;

      /** Begin in-flight feedback for a request about to be issued. */
      const beginProgress = (): void => {
        if (jsonMode || activeProgress) return;
        activeProgress = startLlmProgress({ outStream: progressStream });
      };

      /** Stop/clear feedback, printing the fallback notice on failure. */
      const endProgress = (result?: { usedLlm?: boolean }): void => {
        if (!activeProgress) return;
        const handle = activeProgress;
        activeProgress = null;
        const fallback = result?.usedLlm === false;
        handle.stop({ fallback: fallback && !fallbackNoticeEmitted });
        if (fallback) fallbackNoticeEmitted = true;
      };

      /** Print the fallback notice when no request was issued (unavailable). */
      const noticeFallbackWithoutRequest = (): void => {
        if (jsonMode || fallbackNoticeEmitted) return;
        try {
          progressStream.write(`${LLM_FALLBACK_NOTICE}\n`);
        } catch {
          // Console feedback must never break the command.
        }
        fallbackNoticeEmitted = true;
      };

      /** Explanation for the flagged no-question cases, else null. */
      const explanationFor = async (): Promise<string | null> => {
        if (!item.needsProducerReview || !(noSection || noQuestions)) return null;
        const deps = {
          comments: db.getCommentsForWorkItem(item.id),
          auditResult: db.getAuditResult(item.id),
          chatClient,
          noLlm,
        };
        // `--json` must remain byte-for-byte valid: never emit progress.
        if (jsonMode) {
          const result = await buildProducerReviewExplanationResult(item, deps);
          return result ? result.text : null;
        }
        const willAttempt = !noLlm && chatClient?.available === true;
        if (willAttempt) beginProgress();
        let result: ProducerReviewExplanationResult | null = null;
        try {
          result = await buildProducerReviewExplanationResult(item, deps);
        } finally {
          if (willAttempt) endProgress({ usedLlm: result?.usedLlm ?? false });
        }
        if (!willAttempt && result && !result.usedLlm && !noLlm) {
          noticeFallbackWithoutRequest();
        }
        return result ? result.text : null;
      };

      // ── Non-interactive JSON mode: no prompts, no mutation ───────────
      if (jsonMode) {
        const explanation = await explanationFor();
        output.json({
          success: true,
          workItemId: item.id,
          needsProducerReview: item.needsProducerReview,
          producerReviewExplanation: explanation,
          noSection,
          noQuestions,
          total: pairs.length,
          outstanding,
          allAnswered,
        });
        return;
      }

      // ── Step 1: Show brief summary ───────────────────────────────────
      console.log(`\n=== Interview: ${item.id} ===`);
      console.log(`Title:     ${item.title}`);
      console.log(`Status:    ${item.status}`);
      console.log(`Stage:     ${item.stage}`);
      console.log(
        `Review:    ${item.needsProducerReview ? 'needs review' : 'not flagged'}\n`,
      );

      // ── Step 2: Interactive walkthrough ──────────────────────────────
      const prompts = promptLoopFactory();
      let outcome: InterviewOutcome;
      // Serialise each persisted answer/flag update against a concurrent
      // `wl sync` without holding the store lock across interactive prompts.
      const lockedStore: InterviewStore = {
        update: (itemId, updates) =>
          withStoreMutationLock(ctx.dataPath, () => db.update(itemId, updates)),
      };
      try {
        outcome = await runInterview(
          item,
          lockedStore,
          { prompt: (message: string) => prompts.next(message) },
          {
            llmFallback: llmFallbackEnabled,
            chatClient,
            timeoutMs: EXTRACTION_TIMEOUT_MS,
            onLlmStart: beginProgress,
            onLlmSettled: endProgress,
          },
        );
      } finally {
        prompts.close();
      }

      /**
       * Print the explanation (when the item is flagged and there is nothing
       * to interview), then offer to clear the flag. Returns true when the
       * flag was cleared. Never called in `--json` mode.
       */
      const explainAndOfferClear = async (): Promise<void> => {
        const explanation = await explanationFor();
        if (!explanation) {
          console.log('Nothing to interview. Exiting.');
          return;
        }
        console.log('');
        console.log('Why this item needs producer review:');
        console.log(explanation);
        console.log('');
        const shouldClear = await clearPrompt('Clear the needsProducerReview flag? (y/N)');
        if (shouldClear) {
          withStoreMutationLock(ctx.dataPath, () => db.update(item.id, { needsProducerReview: false }));
          console.log('   needsProducerReview cleared.');
        } else {
          console.log('   needsProducerReview remains flagged.');
        }
      };

      // ── Step 3: Report outcome ───────────────────────────────────────
      if (outcome.extracted > 0) {
        console.log('');
        if (outcome.allAnswered) {
          console.log(
            `✅ ${outcome.recorded} of ${outcome.extracted} LLM-extracted question(s) confirmed for ${normalizedId}.`,
          );
          console.log('   needsProducerReview cleared.');
        } else if (outcome.recorded > 0) {
          console.log(
            `📝 ${outcome.recorded} of ${outcome.extracted} LLM-extracted question(s) confirmed for ${normalizedId}.`,
          );
          console.log(
            `   ${outcome.outstanding} question(s) skipped — needsProducerReview remains flagged.`,
          );
        } else {
          console.log(
            `The LLM suggested ${outcome.extracted} question(s); none were confirmed.`,
          );
        }
        return;
      }
      if (outcome.noSection) {
        console.log('No clarifying-questions section found.');
        await explainAndOfferClear();
        return;
      }
      if (outcome.noQuestions) {
        console.log('No interview questions found in the clarifying section.');
        await explainAndOfferClear();
        return;
      }
      if (outcome.recorded === 0 && outcome.allAnswered) {
        console.log('All questions already have answers.');
        if (item.needsProducerReview) {
          console.log('   needsProducerReview cleared.');
        }
        return;
      }

      console.log('');
      if (outcome.allAnswered) {
        console.log(`✅ ${outcome.recorded} answer(s) recorded for ${normalizedId}.`);
        console.log('   needsProducerReview cleared.');
      } else {
        console.log(`📝 ${outcome.recorded} answer(s) recorded for ${normalizedId}.`);
        console.log(
          `   ${outcome.outstanding} question(s) still outstanding — rerun \`interview\` to resume.`,
        );
      }
    });
}
