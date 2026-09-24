/**
 * Interview command - Interactive walkthrough of outstanding interview
 * questions on a work item, capturing responses and clearing the
 * producer review flag.
 *
 * Parses the "## Clarifying Questions & Answers" section of the work item
 * description, extracts unanswered questions (Q/A pairs where A is empty),
 * prompts the user for each answer interactively, records answers back into
 * the description, and sets needsProducerReview to false.
 *
 * WL-0MU55UDBJ008DJ67
 */

import type { PluginContext } from '../plugin-types.js';
import type { InterviewOptions } from '../cli-types.js';
import type { WorkItem } from '../types.js';
import * as readline from 'readline';

// ── Section markers ──────────────────────────────────────────────────────

const SECTION_HEADER = '## Clarifying Questions & Answers';
const NEXT_SECTION_RE = /^##\s+/;

/**
 * Return type for extractClarifyingSection.
 */
export interface ClarifyingSection {
  header: string;
  content: string;
  start: number;
  end: number;
}

/**
 * Extract the Clarifying Questions & Answers section from a work item
 * description. Returns { header, content } where content is the body
 * after the header (may be empty or contain only prose).
 */
export function extractClarifyingSection(
  description: string,
): { header: string; content: string; start: number; end: number } | null {
  const lines = description.split('\n');
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === SECTION_HEADER) {
      start = i;
      break;
    }
  }

  if (start === -1) return null;

  // Content runs from the line after the header up to the next ## section
  // or end of description.
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
 */
export interface ClarifyingQAPair {
  number: number;
  question: string;
  answer: string;
  unanswered: boolean;
  startLine: number;
  endLine: number;
}

/**
 * Parse Q/A pairs from the clarifying section content.
 *
 * Expected format:
 *   1. **Q: What is the question?**
 *      **A:**
 *   or
 *   2. **Q: Another question?**
 *      **A: The answer goes here.**
 */
export function parseQAPairs(content: string): ClarifyingQAPair[] {
  const lines = content.split('\n');
  const pairs: ClarifyingQAPair[] = [];

  let questionLine = -1;
  let answerLine = -1;
  let questionText = '';
  let answerText = '';
  let questionNumber = 0;

  const questionRe = /^\s*(\d+)\.\s+\*\*Q:\s+(.*?)\*\*/;
  const answerRe = /^\s*\*\*A:\s*(.*?)\*\*$/;

  for (let i = 0; i < lines.length; i++) {
    const qm = lines[i].match(questionRe);
    const am = lines[i].match(answerRe);

    if (qm) {
      // Save previous pair if we had one
      if (questionLine !== -1) {
        pairs.push({
          number: questionNumber,
          question: questionText,
          answer: answerText,
          unanswered: !answerText.trim(),
          startLine: questionLine,
          endLine: answerLine,
        });
      }
      questionNumber = parseInt(qm[1], 10);
      questionText = qm[2].trim();
      questionLine = i;
      answerLine = -1;
      answerText = '';
    } else if (am && questionLine !== -1) {
      answerText = am[1].trim();
      answerLine = i;
    }
  }

  // Flush the last pair
  if (questionLine !== -1) {
    pairs.push({
      number: questionNumber,
      question: questionText,
      answer: answerText,
      unanswered: !answerText.trim(),
      startLine: questionLine,
      endLine: answerLine,
    });
  }

  return pairs;
}

/**
 * Rebuild the clarifying section content from Q/A pairs.
 */
export function rebuildQAPairs(pairs: ClarifyingQAPair[]): string {
  return pairs
    .map(p => {
      const answer = p.unanswered ? '' : p.answer;
      if (answer) {
        return `  ${p.number}. **Q: ${p.question}**\n  **A: ${answer}**`;
      }
      return `  ${p.number}. **Q: ${p.question}**\n  **A:**`;
    })
    .join('\n\n');
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

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('interview <id>')
    .description(
      'Walk through outstanding interview questions on a work item interactively, capturing answers and clearing the producer review flag',
    )
    .option('--prefix <prefix>', 'Override the default prefix')
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

      // ── Step 1: Show brief summary ───────────────────────────────────
      if (!utils.isJsonMode()) {
        console.log(`\n=== Interview: ${item.id} ===`);
        console.log(`Title:     ${item.title}`);
        console.log(`Status:    ${item.status}`);
        console.log(`Stage:     ${item.stage}`);
        console.log(`Review:    ${item.needsProducerReview ? 'needs review' : 'not flagged'}\n`);
      }

      // ── Step 2: Extract clarifying section ───────────────────────────
      const section = extractClarifyingSection(item.description);
      if (!section) {
        if (!utils.isJsonMode()) {
          console.log('No "Clarifying Questions & Answers" section found.');
          console.log('Nothing to interview. Exiting.');
        }
        return;
      }

      const pairs = parseQAPairs(section.content);
      if (pairs.length === 0) {
        if (!utils.isJsonMode()) {
          console.log('No unanswered interview questions found.');
          console.log('Nothing to interview. Exiting.');
        }
        return;
      }

      const unanswered = pairs.filter(p => p.unanswered);
      if (unanswered.length === 0) {
        if (!utils.isJsonMode()) {
          console.log('All questions already have answers. Exiting.');
        }
        // Even if everything is answered, clear the flag if it was set
        if (item.needsProducerReview) {
          db.update(item.id, { needsProducerReview: false });
        }
        return;
      }

      // ── Step 3: Interactive Q&A loop ─────────────────────────────────
      if (utils.isJsonMode()) {
        output.error(
          'Interview mode requires interactive (TTY) input; use without --json',
          { success: false, error: 'requires-tty' },
        );
        process.exit(1);
      }

      console.log(`Found ${unanswered.length} outstanding question(s):\n`);

      // Persist after each answer (AC7 resume): if the session is
      // interrupted (EOF/Ctrl-C), the answers given so far are already in
      // the description, so the next `interview` run only asks what
      // remains outstanding.
      // Persist each answer as it is given (AC7 resume): if the session is
      // interrupted (EOF/Ctrl-C), answers recorded so far stay in the
      // description, so the next `interview` run only asks what remains
      // outstanding. Only clear needsProducerReview once every question has
      // a non-empty answer (AC6).
      const prompts = createPromptLoop();
      let recorded = 0;
      let interrupted = false;
      try {
        for (const pair of unanswered) {
          const answer = await prompts.next(`${pair.number}. ${pair.question}\n   →`);
          const cleaned = answer.replace(/\s+/g, ' ').trim();
          if (cleaned === '') {
            // EOF / empty response — session interrupted; stop asking.
            interrupted = true;
            break;
          }
          pair.answer = cleaned;
          pair.unanswered = false;
          recorded += 1;

          // ── Persist this answer (description) ──
          const newContent = rebuildQAPairs(pairs);
          const newDescription = rebuildDescription(item.description, section, newContent);
          const updated = db.update(item.id, { description: newDescription });
          if (!updated) {
            output.error(`Failed to update work item: ${normalizedId}`, {
              success: false,
              error: 'update-failed',
            });
            process.exit(1);
          }
        }
      } finally {
        prompts.close();
      }

      const allAnswered = !interrupted && pairs.every(p => !p.unanswered);
      if (allAnswered) {
        const updated = db.update(item.id, { needsProducerReview: false });
        if (!updated) {
          output.error(`Failed to update work item: ${normalizedId}`, {
            success: false,
            error: 'update-failed',
          });
          process.exit(1);
        }
      }

      // ── Confirmation ────────────────────────────────────────────────
      console.log('');
      if (!utils.isJsonMode()) {
        if (allAnswered) {
          console.log(`✅ ${recorded} answer(s) recorded for ${normalizedId}.`);
          console.log(`   needsProducerReview cleared.`);
        } else {
          const remaining = pairs.filter(p => p.unanswered).length;
          console.log(`📝 ${recorded} answer(s) recorded for ${normalizedId}.`);
          console.log(`   ${remaining} question(s) still outstanding — rerun \`interview\` to resume.`);
        }
      }
    });
}
