/**
 * Leaked tool-call recovery — pure parsing and repair logic.
 *
 * Some models served through the Local Proxy emit a tool call as plain XML
 * text (the Hermes/Qwen chat-template dialect) instead of a structured
 * `toolCall` content block:
 *
 * ```text
 * <response>
 *  <tool_call>
 *  <function=read>
 *  <parameter=path>
 *  /home/rgardler/.pi/agent/skills/implement/SKILL.md
 *  </parameter>
 *  </function>
 *  </tool_call>
 * </response>
 * ```
 *
 * Pi renders that markup as assistant text and executes nothing, so an
 * unattended agent silently stalls mid-workflow (WL-0MW0WBWY3006LQ8W).
 *
 * This module turns such markup back into structured tool calls. It is
 * deliberately free of Pi imports so it can be unit-tested in isolation and
 * reused by the registration module (`register-leaked-tool-call.ts`).
 *
 * Design notes:
 * - The dialect table is module scope, so adding `<|tool_call|>` /
 *   `to=functions.NAME` / fenced-JSON dialects later is an additive change.
 * - The parser is tolerant of a missing `<tool_call>` opener and of missing
 *   `</function>` / `</tool_call>` closers (both shapes occur live) but is
 *   strict about *safety*: a `<parameter=KEY>` whose value is not terminated
 *   by `</parameter>` marks the call `complete: false` and nothing is
 *   synthesised — a half-streamed `bash` command must never run.
 * - Markup that is *quoted* (fenced code span, inline code span, markdown
 *   blockquote or a quoted snippet) is prose about markup — docs, READMEs,
 *   tests — and is rejected with `reason: 'quoted'` rather than executed.
 * - Repair is a pure transformer: it never mutates the message it is given
 *   and returns a new message object (Pi replaces the finalised message in
 *   place with whatever the `message_end` handler returns). A message that
 *   is already repaired contains no markup, so replaying the repair is a
 *   no-op (idempotence).
 *
 * Skip-reason vocabulary (the name in brackets is the shorthand used in
 * WL-0MW109IIN009PADE's design notes): `unterminated-parameter`
 * (truncated-parameter), `inactive-tool` (unknown-tool), `missing-parameter`
 * (no-parameters), `quoted`, `duplicate` and `unrepairable-stop-reason`.
 *
 * Repair shape (WL-0MW109HU60042BVW AC1/AC2):
 * - an assistant message whose `text` block contains leaked markup gains an
 *   appended `{ type: 'toolCall', id, name, arguments }` block per complete,
 *   active, non-duplicate call (id from `node:crypto`),
 * - `stopReason` becomes `'toolUse'`,
 * - the leaked markup is replaced with a one-line note such as
 *   `[recovered tool call: read(path=/…/SKILL.md)]` (template:
 *   `LEAKED_TOOL_CALL_CONFIG.noteTemplate`),
 * - a duplicate's markup is dropped without a note (the call is already going
 *   to execute), while a call rejected for safety keeps its markup so a human
 *   can see exactly what was refused,
 * - every other message field is preserved.
 *
 * The settings in `LEAKED_TOOL_CALL_CONFIG` are the single source of truth for
 * the fallback (corrective-continue) and documentation slices; this module
 * only *declares* them.
 */

import { randomUUID } from 'node:crypto';

// ── Dialect table ─────────────────────────────────────────────────────

/**
 * One leaked tool-call markup dialect.
 *
 * Only the tag/pattern surface is described here; the parser drives it. Keep
 * the patterns as *sources* (not shared `RegExp` instances) because a
 * `g`-flagged regex carries mutable `lastIndex` state between scans.
 */
export interface LeakedToolCallDialect {
  /** Stable identifier used in tests and diagnostics. */
  id: string;
  /** Outer response wrapper open tag. */
  responseOpen: string;
  /** Outer response wrapper close tag. */
  responseClose: string;
  /** Per-call wrapper open tag (may be missing). */
  callOpen: string;
  /** Per-call wrapper close tag (may be missing). */
  callClose: string;
  /** `<function=NAME>` opener (group 1 = tool name), global. */
  functionOpen: RegExp;
  /** `</function>` closer (may be missing). */
  functionClose: string;
  /** `<parameter=KEY>` opener (group 1 = parameter name), global. */
  parameterOpen: RegExp;
  /** `</parameter>` closer — its absence marks the value unterminated. */
  parameterClose: string;
}

const TOOL_NAME_PATTERN = '[A-Za-z0-9_.:-]+';

/**
 * Hermes/Qwen XML dialect — the leak shape observed live (2026-09-17 session
 * corpus and the operator's TUI report of 2026-11-03).
 *
 * The list is exported so a future dialect is an additive entry rather than a
 * parser rewrite (parent AC: dialect scope is XML/Hermes only for now).
 */
export const LEAKED_TOOL_CALL_DIALECTS: readonly LeakedToolCallDialect[] =
  Object.freeze([
    Object.freeze({
      id: 'hermes-qwen-xml',
      responseOpen: '<response>',
      responseClose: '</response>',
      callOpen: '<tool_call>',
      callClose: '</tool_call>',
      functionOpen: new RegExp(`<function=(${TOOL_NAME_PATTERN})>`, 'g'),
      functionClose: '</function>',
      parameterOpen: new RegExp(`<parameter=(${TOOL_NAME_PATTERN})>`, 'g'),
      parameterClose: '</parameter>',
    }),
  ]);

/** The dialect used when a caller does not name one. */
export const DEFAULT_LEAKED_TOOL_CALL_DIALECT: LeakedToolCallDialect =
  LEAKED_TOOL_CALL_DIALECTS[0];

// ── Settings ──────────────────────────────────────────────────────────

/**
 * The recovery settings shared by every slice of the capability.
 *
 * The fallback slice (bounded corrective continue) and the docs slice consume
 * these values instead of restating them, so the bound, the note format and
 * the corrective prompt have exactly one definition
 * (WL-0MW109IIN009PADE AC6).
 */
export interface LeakedToolCallConfig {
  /** Whether leaked-call recovery is active at all. */
  readonly enabled: boolean;
  /** Maximum recoveries (repair + fallback) per session. */
  readonly sessionCap: number;
  /**
   * Template for the one-line note that replaces recovered markup.
   * Placeholders: `{name}` and `{arguments}`.
   */
  readonly noteTemplate: string;
  /** Prompt used by the bounded corrective-continue fallback. */
  readonly correctiveContinuationPrompt: string;
}

/** Defaults: enabled, five recoveries per session, one note format. */
export const LEAKED_TOOL_CALL_CONFIG: Readonly<LeakedToolCallConfig> = Object.freeze({
  enabled: true,
  sessionCap: 5,
  noteTemplate: '[recovered tool call: {name}({arguments})]',
  correctiveContinuationPrompt:
    'Your previous message contained a tool call written as plain text, so it never ran. ' +
    'Re-issue that tool call through the structured tool-call interface instead of writing the markup as text.',
});

// ── Parsed call shape ─────────────────────────────────────────────────

/** Why a parsed call was not turned into a structured `toolCall`. */
export type LeakedToolCallSkipReason =
  /** A `<parameter=KEY>` value was not terminated by `</parameter>`. */
  | 'unterminated-parameter'
  /** No `<parameter=KEY>` block at all — not enough evidence to execute. */
  | 'missing-parameter'
  /** The parsed tool name is not in `pi.getActiveTools()`. */
  | 'inactive-tool'
  /** The message already carries an identical structured `toolCall`. */
  | 'duplicate'
  /** The markup sits inside a quoted/fenced prose example, not a real leak. */
  | 'quoted'
  /** The message's `stopReason` cannot be trusted to be a finished turn. */
  | 'unrepairable-stop-reason';

/** A single leaked call parsed out of a text block. */
export interface ParsedLeakedToolCall {
  /** Parsed tool name (`<function=NAME>`). */
  name: string;
  /** Parsed arguments, keyed by `<parameter=KEY>`; values are trimmed text. */
  arguments: Record<string, string>;
  /**
   * `true` only when the markup is self-contained and safe to execute:
   * at least one parameter and every parameter value terminated.
   */
  complete: boolean;
  /** Set when `complete` is `false`; also set when repair skips the call. */
  reason?: LeakedToolCallSkipReason;
  /** Offset of the `<function=NAME>` opener within the text block. */
  start: number;
  /** Offset just past the call markup (includes a trailing `</tool_call>`). */
  end: number;
  /** The raw markup slice for this call. */
  text: string;
}

// ── Parsing ───────────────────────────────────────────────────────────

/**
 * Parse every leaked tool call in `text`.
 *
 * Tolerant of a missing `<tool_call>` opener and of missing `</function>` /
 * `</tool_call>` closers. Returns an empty array for markup-free text.
 */
export function parseLeakedToolCalls(
  text: string,
  dialect: LeakedToolCallDialect = DEFAULT_LEAKED_TOOL_CALL_DIALECT,
): ParsedLeakedToolCall[] {
  if (typeof text !== 'string' || text.length === 0) return [];

  const openers: Array<{ name: string; start: number }> = [];
  const functionOpen = new RegExp(dialect.functionOpen.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = functionOpen.exec(text)) !== null) {
    openers.push({ name: match[1], start: match.index });
  }
  if (openers.length === 0) return [];

  const calls: ParsedLeakedToolCall[] = [];
  for (let index = 0; index < openers.length; index += 1) {
    const opener = openers[index];
    const nextOpenerStart =
      index + 1 < openers.length ? openers[index + 1].start : text.length;
    const openerEnd = opener.start + `<function=${opener.name}>`.length;

    // The function body ends at `</function>` when present, otherwise at the
    // next `<function=` opener (or end of text).
    const functionCloseIndex = text.indexOf(dialect.functionClose, openerEnd);
    const bodyEnd =
      functionCloseIndex !== -1 && functionCloseIndex < nextOpenerStart
        ? functionCloseIndex
        : nextOpenerStart;
    const body = text.slice(openerEnd, bodyEnd);

    // Consume a `</tool_call>` that directly follows the function block so the
    // note (or the dropped duplicate) replaces the per-call wrapper too.
    let end =
      functionCloseIndex !== -1 && functionCloseIndex < nextOpenerStart
        ? functionCloseIndex + dialect.functionClose.length
        : bodyEnd;
    const trailingCallClose = new RegExp(
      `^\\s*${escapeRegExp(dialect.callClose)}`,
    ).exec(text.slice(end));
    if (trailingCallClose) end += trailingCallClose[0].length;

    // False-positive guard: markup inside a fenced/inline code span, a
    // blockquote or a quoted snippet is prose *about* markup (docs, READMEs,
    // tests), never a leaked call. Reject it before reading any parameter.
    if (isQuotedMarkup(text, opener.start)) {
      calls.push({
        name: opener.name,
        arguments: {},
        complete: false,
        reason: 'quoted',
        start: opener.start,
        end,
        text: text.slice(opener.start, end),
      });
      continue;
    }

    const parameters: Array<{ key: string; start: number; valueStart: number }> = [];
    const parameterOpen = new RegExp(dialect.parameterOpen.source, 'g');
    let parameterMatch: RegExpExecArray | null;
    while ((parameterMatch = parameterOpen.exec(body)) !== null) {
      parameters.push({
        key: parameterMatch[1],
        start: parameterMatch.index,
        valueStart: parameterMatch.index + parameterMatch[0].length,
      });
    }

    const args: Record<string, string> = {};
    let complete = true;
    let reason: LeakedToolCallSkipReason | undefined;

    if (parameters.length === 0) {
      complete = false;
      reason = 'missing-parameter';
    } else {
      for (let p = 0; p < parameters.length; p += 1) {
        const parameter = parameters[p];
        const boundaryStart =
          p + 1 < parameters.length ? parameters[p + 1].start : body.length;
        const closeIndex = body.indexOf(dialect.parameterClose, parameter.valueStart);
        if (closeIndex === -1 || closeIndex > boundaryStart) {
          complete = false;
          reason = 'unterminated-parameter';
          break;
        }
        args[parameter.key] = body.slice(parameter.valueStart, closeIndex).trim();
      }
    }

    calls.push({
      name: opener.name,
      arguments: args,
      complete,
      ...(reason ? { reason } : {}),
      start: opener.start,
      end,
      text: text.slice(opener.start, end),
    });
  }
  return calls;
}

// ── Note formatting ───────────────────────────────────────────────────

/** Prefix of the one-line note that replaces recovered markup. */
export const RECOVERY_NOTE_PREFIX = '[recovered tool call: ';

/** Maximum length of a single argument value inside the note. */
export const MAX_NOTE_ARG_LENGTH = 60;

/** Render the one-line replacement note for a recovered call. */
export function formatRecoveryNote(call: {
  name: string;
  arguments: Record<string, string>;
}): string {
  const rendered = Object.entries(call.arguments)
    .map(([key, value]) => `${key}=${truncate(collapseWhitespace(value), MAX_NOTE_ARG_LENGTH)}`)
    .join(', ');
  return LEAKED_TOOL_CALL_CONFIG.noteTemplate
    .split(NOTE_NAME_PLACEHOLDER)
    .join(call.name)
    .split(NOTE_ARGUMENTS_PLACEHOLDER)
    .join(rendered);
}

/** Placeholder for the tool name in `LEAKED_TOOL_CALL_CONFIG.noteTemplate`. */
export const NOTE_NAME_PLACEHOLDER = '{name}';

/** Placeholder for the rendered arguments in the note template. */
export const NOTE_ARGUMENTS_PLACEHOLDER = '{arguments}';

// ── Message repair ────────────────────────────────────────────────────

/** A content block on a recoverable assistant message. */
export interface RecoverableContentBlock {
  type: string;
  [key: string]: unknown;
}

/** A `text` content block. */
export interface RecoverableTextBlock extends RecoverableContentBlock {
  type: 'text';
  text: string;
}

/** A structured `toolCall` content block. */
export interface RecoverableToolCallBlock extends RecoverableContentBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Minimal structural view of an assistant message (no Pi import). */
export interface RecoverableAssistantMessage {
  role: string;
  content: RecoverableContentBlock[];
  stopReason?: string;
}

/** A structured tool call synthesised from leaked markup. */
export interface RecoveredToolCall {
  id: string;
  name: string;
  arguments: Record<string, string>;
  /** One-line note that replaced the markup. */
  note: string;
}

/** Outcome of repairing one assistant message. */
export interface RepairOutcome<T extends RecoverableAssistantMessage> {
  /** The repaired message, or the original when `repaired` is `false`. */
  message: T;
  /** Calls synthesised into structured `toolCall` blocks. */
  recovered: RecoveredToolCall[];
  /** Calls present in the markup that were deliberately not executed. */
  skipped: ParsedLeakedToolCall[];
  /** `true` when the message was changed and should replace the original. */
  repaired: boolean;
}

/**
 * What happens to one parsed call inside a text block: recover it, drop it as a
 * duplicate (no note — the call is already executing) or keep its markup (the
 * call was rejected for safety and stays visible).
 */
type BlockDecision =
  | { call: ParsedLeakedToolCall; action: 'keep' }
  | { call: ParsedLeakedToolCall; action: 'drop-duplicate' }
  | { call: ParsedLeakedToolCall; action: 'recover'; note: string };

/**
 * Stop reasons from which a leaked call may be repaired. A `length` (max
 * tokens) or `error`/`aborted` stop means the text may be truncated or the run
 * already failed, so nothing is executed (safety guard, AC2).
 */
export const REPAIRABLE_STOP_REASONS: readonly string[] = Object.freeze([
  'stop',
  'toolUse',
]);

/**
 * Append structured `toolCall` blocks for leaked markup and strip the markup.
 *
 * Pure: the input message is never mutated.
 */
export function repairAssistantMessage<T extends RecoverableAssistantMessage>(
  message: T,
  activeTools: readonly string[],
): RepairOutcome<T> {
  const unchanged: RepairOutcome<T> = {
    message,
    recovered: [],
    skipped: [],
    repaired: false,
  };
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return unchanged;
  }

  const parsedByBlock = message.content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return [];
    return parseLeakedToolCalls(block.text);
  });
  const parsedCount = parsedByBlock.reduce((total, calls) => total + calls.length, 0);
  if (parsedCount === 0) return unchanged;

  const stopReasonRepairable =
    message.stopReason === undefined ||
    REPAIRABLE_STOP_REASONS.includes(message.stopReason);

  const active = new Set(activeTools ?? []);
  const existingToolCalls = message.content.filter(
    (block): block is RecoverableToolCallBlock => block?.type === 'toolCall',
  );

  const recovered: RecoveredToolCall[] = [];
  const skipped: ParsedLeakedToolCall[] = [];
  const synthesised: RecoverableToolCallBlock[] = [];

  const content = message.content.map((block, blockIndex): RecoverableContentBlock => {
    const parsed = parsedByBlock[blockIndex];
    if (parsed.length === 0) return block;

    const text = (block as RecoverableTextBlock).text;
    const decisions: BlockDecision[] = [];

    for (const call of parsed) {
      if (!call.complete) {
        skipped.push(call);
        decisions.push({ call, action: 'keep' });
        continue;
      }
      if (!stopReasonRepairable) {
        skipped.push({ ...call, complete: false, reason: 'unrepairable-stop-reason' });
        decisions.push({ call, action: 'keep' });
        continue;
      }
      if (!active.has(call.name)) {
        skipped.push({ ...call, complete: false, reason: 'inactive-tool' });
        decisions.push({ call, action: 'keep' });
        continue;
      }
      if (existingToolCalls.some((existing) => isSameCall(existing, call))) {
        skipped.push({ ...call, complete: false, reason: 'duplicate' });
        decisions.push({ call, action: 'drop-duplicate' });
        continue;
      }

      const note = formatRecoveryNote(call);
      const toolCall: RecoverableToolCallBlock = {
        type: 'toolCall',
        id: `call_${randomUUID()}`,
        name: call.name,
        arguments: { ...call.arguments },
      };
      // Register before the next parsed call so an identical duplicate in the
      // same message is dropped instead of executed twice (AC3).
      existingToolCalls.push(toolCall);
      synthesised.push(toolCall);
      recovered.push({
        id: toolCall.id,
        name: call.name,
        arguments: { ...call.arguments },
        note,
      });
      decisions.push({ call, action: 'recover', note });
    }

    // A block with nothing recovered is returned untouched: safety-rejected
    // markup (and an all-duplicate block) is evidence, not something to rewrite.
    if (!decisions.some((decision) => decision.action === 'recover')) return block;

    let rebuilt = '';
    let cursor = 0;
    for (const decision of decisions) {
      if (decision.action === 'keep') continue; // leave rejected markup in place
      rebuilt += text.slice(cursor, decision.call.start);
      if (decision.action === 'recover') rebuilt += decision.note;
      cursor = decision.call.end;
    }

    rebuilt += text.slice(cursor);
    return { ...block, text: stripWrapperTags(rebuilt) };
  });

  if (recovered.length === 0) {
    return { message, recovered, skipped, repaired: false };
  }

  const repairedMessage = {
    ...message,
    content: [...content, ...synthesised],
    stopReason: 'toolUse',
  } as T;

  return { message: repairedMessage, recovered, skipped, repaired: true };
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Is the markup at `offset` quoted prose rather than a leaked call?
 *
 * True when the offset sits inside a fenced code span (``` / ~~~) or an inline
 * code span, on a markdown blockquote line (`>`), or immediately after an
 * opening double quote. Those are the shapes a README, a test fixture or a
 * chat message uses to *talk about* the markup, and rewriting them would
 * corrupt legitimate prose (AC2 false-positive guard).
 *
 * Deliberately conservative: an unrecognised shape is treated as a leak so the
 * safety guards (unterminated parameter, inactive tool, missing parameter)
 * still decide whether anything executes.
 */
export function isQuotedMarkup(text: string, offset: number): boolean {
  if (offset < 0 || offset > text.length) return false;

  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const linePrefix = text.slice(lineStart, offset);

  // Markdown blockquote: `> <function=…>` (the example is quoted prose).
  if (/^\s*>/.test(linePrefix)) return true;

  // Inline code span: an odd number of backticks before the markup on its line.
  if ((linePrefix.match(/`/g) ?? []).length % 2 === 1) return true;

  // Quoted snippet: `"<function=…` — the sentence quotes the markup.
  if (/["\u201c]\s*$/.test(linePrefix)) return true;

  return isInsideFencedCode(text, offset);
}

/**
 * Is `offset` inside a fenced code block?
 *
 * Walks the lines before the offset, toggling on each ``` / ~~~ fence line. A
 * one-line ```` ```markup``` ```` span is not detected — the inline-backtick rule
 * above already covers it.
 */
function isInsideFencedCode(text: string, offset: number): boolean {
  let inside = false;
  let lineStart = 0;

  while (lineStart <= offset) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (offset <= lineEnd) break; // this line holds the offset
    if (/^\s*(```|~~~)/.test(text.slice(lineStart, lineEnd))) inside = !inside;
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return inside;
}

function stripWrapperTags(
  text: string,
  dialect: LeakedToolCallDialect = DEFAULT_LEAKED_TOOL_CALL_DIALECT,
): string {
  let out = text;
  for (const tag of [
    dialect.responseOpen,
    dialect.responseClose,
    dialect.callOpen,
    dialect.callClose,
  ]) {
    out = out.split(tag).join('');
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isSameCall(
  existing: RecoverableToolCallBlock,
  parsed: ParsedLeakedToolCall,
): boolean {
  // Leaked arguments are always strings, so string comparison of the rendered
  // values is the deep equality we need (AC3: name + arguments identical).
  if (existing.name !== parsed.name) return false;
  const existingArgs = existing.arguments ?? {};
  const existingKeys = Object.keys(existingArgs);
  const parsedKeys = Object.keys(parsed.arguments);
  if (existingKeys.length !== parsedKeys.length) return false;
  return parsedKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(existingArgs, key) &&
      String(existingArgs[key]) === String(parsed.arguments[key]),
  );
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
