/**
 * src/interview/extraction.ts — LLM-assisted clarifying-question extraction:
 * instruction, caps, prompt builder, defensive response parser, the extract
 * calls and the canonical section insert/merge helpers.
 *
 * Responsibility: turn a description into operator-confirmable questions when
 * the deterministic parser finds none, degrading silently on any LLM failure.
 *
 * Extracted verbatim from src/commands/interview.ts (WL-0MVXY381R008ZO2E).
 */

import type { ChatClient } from '../lib/llm.js';
import type { ClarifyingQAPair } from './qa.js';

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
