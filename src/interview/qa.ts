/**
 * src/interview/qa.ts — Q/A pair parsing, answer-region computation and
 * lossless re-serialisation for the clarifying-questions appendix.
 *
 * Responsibility: parse the appendix into Q/A pairs and rebuild it verbatim,
 * rewriting only the answer value when one is replaced.
 *
 * Extracted verbatim from src/commands/interview.ts (WL-0MVXY36EA009TH9Q).
 */

import type { ClarifyingSection } from './section.js';

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
  section: ClarifyingSection | null,
  newContent: string,
): string {
  if (!section) return description;

  const lines = description.split('\n');
  const before = lines.slice(0, section.start + 1); // header line
  const after = lines.slice(section.end); // next section or end

  return [...before, newContent, ...after].join('\n').trim();
}
