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

export * from '../interview/section.js';
export * from '../interview/qa.js';

import {
  extractClarifyingSection,
  type ClarifyingSection,
} from '../interview/section.js';
import {
  parseQAPairs,
  rebuildQAPairs,
  rebuildDescription,
  type ClarifyingQAPair,
} from '../interview/qa.js';

export * from '../interview/explanation.js';

import {
  buildProducerReviewExplanationResult,
  type ProducerReviewExplanationResult,
} from '../interview/explanation.js';

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a char.
 * (Duplicated from explanation.ts while the extraction section still lives in
 * this module; the copy moves with it in WL-0MVXY381R008ZO2E.)
 */
function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = text;
  while (result.length > 0 && Buffer.byteLength(result, 'utf8') > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
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
