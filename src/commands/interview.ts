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
 * WL-0MU55UDBJ008DJ67
 */

import type { PluginContext } from '../plugin-types.js';
import type { InterviewOptions } from '../cli-types.js';
import type { WorkItem, Comment } from '../types.js';
import { OpenAIChatClient, type ChatClient } from '../lib/llm.js';
import { resolveLlmConfig } from '../config.js';
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
 * Instruction sent to the LLM when explaining how to clear the
 * `needsProducerReview` flag (parent AC2).
 */
export const PRODUCER_REVIEW_INSTRUCTION =
  'Explain what the producer needs to do in order to remove the needsProducerReview flag';

/** Maximum size (bytes) of the item context embedded in the prompt. */
export const MAX_PROMPT_CONTEXT_BYTES = 8192;

/** Maximum length (characters) of the normalised explanation line. */
export const MAX_EXPLANATION_LENGTH = 500;

/** Default timeout (ms) for the explanation LLM call. */
export const EXPLANATION_TIMEOUT_MS = 15000;

/**
 * Dependencies for {@link buildProducerReviewExplanation}. The chat client is
 * injected so callers (and tests) never make network calls implicitly.
 */
export interface ProducerReviewExplanationDeps {
  /** Newest-first comments for the item (`getCommentsForWorkItem` order). */
  comments: Comment[];
  /** Chat client to use; `null`/`undefined` disables the LLM path. */
  chatClient?: ChatClient | null;
  /** When true, skip the LLM entirely and use the comment-based fallback. */
  noLlm?: boolean;
  /** Per-call timeout override in milliseconds. */
  timeoutMs?: number;
}

/**
 * Collapse whitespace so an explanation renders as a single bounded line.
 * Newlines (from either path) are collapsed; over-long text is truncated.
 */
export function normaliseExplanation(
  text: string,
  maxLength: number = MAX_EXPLANATION_LENGTH,
): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.slice(0, maxLength - 1).trimEnd() + '…';
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
 * Build the LLM prompt: the fixed instruction plus item context
 * (description and the two most recent comments), bounded to
 * {@link MAX_PROMPT_CONTEXT_BYTES}.
 */
export function buildExplanationPrompt(item: WorkItem, comments: Comment[]): string {
  const recent = comments
    .slice(0, 2)
    .map(c => `${c.author}: ${firstLine(c.comment)}`)
    .join('\n');
  const context = [
    `Work item: ${item.id} — ${item.title}`,
    '',
    'Description:',
    item.description,
    '',
    'Most recent comments:',
    recent || '(none)',
  ].join('\n');
  return `${PRODUCER_REVIEW_INSTRUCTION}.\n\n${truncateBytes(context, MAX_PROMPT_CONTEXT_BYTES)}`;
}

/**
 * Comment-based fallback: `<author>: <first line>` for the two most recent
 * comments, joined on one line. When there are no usable comments a generic
 * actionable line is returned so the producer still has a clear next step.
 */
export function buildCommentFallback(item: WorkItem, comments: Comment[]): string {
  const recent = comments
    .slice(0, 2)
    .map(c => `${c.author}: ${firstLine(c.comment)}`)
    .filter(entry => entry.replace(/^[^:]*:\s*/, '').length > 0);
  if (recent.length > 0) return recent.join('; ');
  return (
    `No recent comments; review the item and clear the flag with ` +
    `\`wl reviewed ${item.id} false\` once the blocker is resolved.`
  );
}

/**
 * Produce a one-line explanation of how the producer clears
 * `needsProducerReview`.
 *
 * Returns `null` when the item is not flagged. Otherwise it calls the injected
 * chat client (unless `noLlm` is set or the client is unavailable) and falls
 * back silently to the two most recent comments on any failure — network
 * error, non-2xx, timeout or empty response (parent AC2/AC3).
 */
export async function buildProducerReviewExplanation(
  item: WorkItem,
  deps: ProducerReviewExplanationDeps,
): Promise<string | null> {
  if (!item.needsProducerReview) return null;

  if (!deps.noLlm && deps.chatClient?.available) {
    try {
      const response = await deps.chatClient.complete(
        buildExplanationPrompt(item, deps.comments),
        { timeoutMs: deps.timeoutMs ?? EXPLANATION_TIMEOUT_MS },
      );
      const normalised = normaliseExplanation(response);
      if (normalised.length > 0) return normalised;
    } catch {
      // Silent fallback — the explanation is advisory; never surface an error.
    }
  }

  return normaliseExplanation(buildCommentFallback(item, deps.comments));
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
}

/**
 * Walk the outstanding questions on `item`, prompting via `io` and writing
 * each answer back to the description as it is given.
 *
 * Answers are persisted after each response so an interrupted session can be
 * resumed; the producer review flag is only cleared once every question has
 * a non-empty answer.
 */
export async function runInterview(
  item: WorkItem,
  store: InterviewStore,
  io: InterviewIO,
): Promise<InterviewOutcome> {
  const empty: InterviewOutcome = {
    noSection: false,
    noQuestions: false,
    recorded: 0,
    total: 0,
    outstanding: 0,
    allAnswered: false,
  };

  const section = extractClarifyingSection(item.description);
  if (!section) return { ...empty, noSection: true };

  const pairs = parseQAPairs(section.content);
  if (pairs.length === 0) return { ...empty, noQuestions: true };

  const unanswered = pairs.filter(p => p.unanswered);
  if (unanswered.length === 0) {
    if (item.needsProducerReview) {
      store.update(item.id, { needsProducerReview: false });
    }
    return {
      ...empty,
      total: pairs.length,
      allAnswered: true,
    };
  }

  let recorded = 0;
  let interrupted = false;

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

    const newContent = rebuildQAPairs(pairs);
    const newDescription = rebuildDescription(item.description, section, newContent);
    store.update(item.id, { description: newDescription });
  }

  const allAnswered = !interrupted && pairs.every(p => !p.unanswered);
  if (allAnswered) {
    store.update(item.id, { needsProducerReview: false });
  }

  return {
    noSection: false,
    noQuestions: false,
    recorded,
    total: pairs.length,
    outstanding: pairs.filter(p => p.unanswered).length,
    allAnswered,
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

/** Injectable dependencies for the interview command (used by tests). */
export interface InterviewCommandDeps {
  /**
   * Build the chat client for the explanation. Return `null` to disable the
   * LLM path. Defaults to an `OpenAIChatClient` over the resolved LLM config.
   */
  chatClientFactory?: (options: { model?: string }) => ChatClient | null;
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

  program
    .command('interview <id>')
    .description(
      'Walk through outstanding interview questions on a work item interactively, capturing answers and clearing the producer review flag',
    )
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--json', 'Non-interactive JSON output (no prompts, no mutation)')
    .option('--no-llm', 'Disable the LLM explanation and use the comment fallback')
    .option('--model <model>', 'Override the chat model for the explanation')
    .action(async (id: string, options: InterviewOptions) => {
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

      const section = extractClarifyingSection(item.description);
      const pairs = section ? parseQAPairs(section.content) : [];
      const noSection = section === null;
      const noQuestions = section !== null && pairs.length === 0;
      const outstanding = pairs.filter(p => p.unanswered).length;
      const allAnswered = !noSection && !noQuestions && outstanding === 0;

      /** Explanation for the flagged no-question cases, else null. */
      const explanationFor = async (): Promise<string | null> => {
        if (!item.needsProducerReview || !(noSection || noQuestions)) return null;
        return buildProducerReviewExplanation(item, {
          comments: db.getCommentsForWorkItem(item.id),
          chatClient: noLlm ? null : chatClientFactory({ model: options.model }),
          noLlm,
        });
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
      const prompts = createPromptLoop();
      let outcome: InterviewOutcome;
      try {
        outcome = await runInterview(item, db, {
          prompt: (message: string) => prompts.next(message),
        });
      } finally {
        prompts.close();
      }

      // ── Step 3: Report outcome ───────────────────────────────────────
      if (outcome.noSection) {
        console.log('No clarifying-questions section found.');
        const explanation = await explanationFor();
        if (explanation) {
          console.log('');
          console.log(explanation);
          console.log('');
        } else {
          console.log('Nothing to interview. Exiting.');
        }
        return;
      }
      if (outcome.noQuestions) {
        console.log('No interview questions found in the clarifying section.');
        const explanation = await explanationFor();
        if (explanation) {
          console.log('');
          console.log(explanation);
          console.log('');
        } else {
          console.log('Nothing to interview. Exiting.');
        }
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
