/**
 * src/interview/loop.ts — interactive interview walkthrough: prompt for
 * answers, persist them and account for the outcome.
 *
 * Responsibility: walk the outstanding questions on an item, writing each
 * answer back through the deterministic re-serialiser and clearing the
 * producer review flag once every question is answered.
 *
 * Extracted verbatim from src/commands/interview.ts (WL-0MVXY38W40099KCO).
 */

import type { ChatClient } from '../lib/llm.js';
import type { WorkItem } from '../types.js';
import {
  extractClarifyingSection,
  type ClarifyingSection,
} from './section.js';
import {
  parseQAPairs,
  rebuildQAPairs,
  rebuildDescription,
  type ClarifyingQAPair,
} from './qa.js';
import {
  buildExtractedPairs,
  insertClarifyingSection,
  tryExtractQuestionsWithLlm,
} from './extraction.js';

/** Merge new extracted pairs into an existing (question-free) section body. */
function mergeExtractedIntoSection(existing: string, content: string): string {
  const base = existing.replace(/\s+$/, '');
  const body = content.replace(/\s+$/, '');
  if (base.length === 0) return body;
  if (body.length === 0) return base;
  return `${base}\n${body}`;
}

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
