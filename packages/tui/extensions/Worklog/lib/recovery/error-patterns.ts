/**
 * Error classification patterns for the recovery module.
 *
 * Ported and enhanced from pi-retry's error-patterns.ts. Provides
 * per-category detection with configurable regex patterns that can be
 * overridden via settings.
 *
 * Nine error categories are defined:
 * - Rate limits (429)        → NOT retried (informative error)
 *   (exception: an llm-proxy local-admission refusal is capacity
 *   backpressure, not a rate limit — a retryable one is classified
 *   SERVER_ERROR so the `Retry-After` hint is honoured;
 *   WL-0MVSBF5XZ001H7V7)
 * - Server errors (5xx)      → retried with configurable backoff
 * - Auth errors (401/403)    → NOT retried (checkpoint + terminal)
 * - Context-length exceeded  → /compact + auto-continue
 * - Quota exhausted          → NOT retried (checkpoint + terminal)
 * - Timeout                  → retried with configurable backoff
 * - Terminated               → NOT retried (checkpoint + terminal)
 * - Parse errors (JSON)      → single-shot continue (no backoff)
 * - Compaction gate (4xx)    → /compact + auto-continue (cheap-mode cap)
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

// ── Error categories ─────────────────────────────────────────────────

export enum ErrorCategory {
  RATE_LIMIT = 'rateLimit',
  SERVER_ERROR = 'serverError',
  AUTH_ERROR = 'authError',
  CONTEXT_LENGTH = 'contextLength',
  QUOTA_EXHAUSTED = 'quotaExhausted',
  TIMEOUT = 'timeout',
  TERMINATED = 'terminated',
  PARSE_ERROR = 'parseError',
  COMPACTION_GATE = 'compactionGate',
  UNKNOWN = 'unknown',
}

// ── Config types ──────────────────────────────────────────────────────

/**
 * Per-category configuration for recovery behavior.
 */
export interface RecoveryCategoryConfig {
  /** Whether this category should be retried */
  enabled: boolean;
  /** Regex patterns to match against error messages */
  patterns: RegExp[];
  /** Base delay in ms for exponential backoff (used for retryable categories) */
  baseDelayMs: number;
  /** Max delay in ms for exponential backoff (cap for retryable categories) */
  maxDelayMs: number;
  /**
   * Optional continuation prompt text (used for context-length category).
   * The prompt text sent to the LLM after /compact to continue generation.
   */
  continuationPrompt?: string;
}

/**
 * Bounded default cooldown policy for the durable model-cooldown marker
 * (WL-0MV5639X70029BOI).
 *
 * When the recovery loop classifies a provider-exhaustion `SERVER_ERROR` it
 * records a machine-wide cooldown marker so the cheap-switch worker holds the
 * shared proxy in fast mode instead of adding concurrency during a known
 * provider-exhaustion window. The marker's `cooldownUntil` tracks the
 * server-requested `Retry-After` when one is available; when the hint is
 * absent or malformed the loop falls back to {@link RecoveryCooldownConfig.defaultMs}.
 *
 * Every value is clamped into `[floorMs, ceilingMs]` so the marker can never
 * be a **zero hold** (which would let the cheap switch fire while the pane is
 * still backing off) and can never be an **unbounded hold** (which would pin
 * the shared proxy in fast mode forever). This is documented alongside the
 * per-category `baseDelayMs`/`maxDelayMs` values: those bound the retry-sleep
 * backoff, whereas these bound the durable cooldown signal.
 */
export interface RecoveryCooldownConfig {
  /**
   * Default cooldown (ms) used when the recovery loop has no usable server
   * hint. Aligned with the retry-loop exponential ceiling so the marker
   * covers the longest inter-attempt wait the loop can take.
   */
  defaultMs: number;
  /**
   * Clamp floor (ms): the default is never shorter than this, so a
   * zero/degenerate cooldown can never open a premature cheap-switch window.
   * Must be greater than zero.
   */
  floorMs: number;
  /**
   * Clamp ceiling (ms): the default (and any server hint) is never longer
   * than this, so a malformed or absurd value cannot pin the cooldown open.
   * Aligned with `DEFAULT_SERVER_HINT_MAX_DELAY_MS` (6 h).
   */
  ceilingMs: number;
}

/**
 * Complete recovery configuration covering all error categories.
 */
export interface RecoveryConfig {
  rateLimit: RecoveryCategoryConfig;
  serverError: RecoveryCategoryConfig;
  authError: RecoveryCategoryConfig;
  contextLength: RecoveryCategoryConfig;
  quotaExhausted: RecoveryCategoryConfig;
  timeout: RecoveryCategoryConfig;
  terminated: RecoveryCategoryConfig;
  parseError: RecoveryCategoryConfig;
  compactionGate: RecoveryCategoryConfig;
  /**
   * Bounded default cooldown policy for the durable model-cooldown marker
   * (WL-0MV5639X70029BOI). Not an error category: it carries no `patterns`
   * and bounds the marker, not the retry-sleep backoff.
   */
  cooldown: RecoveryCooldownConfig;
}

// ── Type guard ─────────────────────────────────────────────────────────

function isAssistantMessage(msg: unknown): msg is AgentMessage & { errorMessage: string } {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.role === 'assistant' && typeof m.errorMessage === 'string' && m.errorMessage.length > 0;
}

// ── Default patterns (ported from pi-retry error-patterns.ts) ────────

const DEFAULT_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
];

/**
 * Provider-exhaustion pattern set.
 *
 * These are the model-unavailable bodies the llm-proxy returns when every
 * upstream provider is throttled/out of its scheduled window: "all providers
 * exhausted", "all providers unavailable", "no provider is available during
 * the current scheduled time window". They are a subset of the SERVER_ERROR
 * classification (so the recovery loop retries with exponential backoff) and
 * double as the trigger for the durable model-cooldown marker
 * (WL-0MV5638J1006URXA): a plain retryable 5xx or timeout must NOT record a
 * cooldown.
 */
export const EXHAUSTION_SERVER_ERROR_PATTERNS: RegExp[] = [
  /all providers exhausted/i,
  // llm-proxy scheduled-window exhaustion body (proxy returns HTTP 503):
  // "All providers unavailable: no provider is available during the current
  // scheduled time window". Classified as SERVER_ERROR so the recovery loop
  // retries with exponential backoff instead of treating it as UNKNOWN and
  // silently stalling the turn (WL-0MU56ZSSB0054D8W, extending the
  // WL-0MT656GDS0052FTK fix for "all providers exhausted"). The optional
  // "(is )" group also covers the earlier "no provider available" wording,
  // so this single pattern replaces that former narrower entry rather than
  // leaving it as an unreachable duplicate. Longer term, key off a stable
  // machine-readable `code`/`type` field once the proxy exposes one — see
  // follow-up LP-0MU56ZM0K005F69G.
  /all providers unavailable/i,
  /no provider\s+(is\s+)?available/i,
  /scheduled time window/i,
  /outside its available_times/i,
];

/**
 * Local-admission refusal prose (WL-0MVSBF5XZ001H7V7).
 *
 * When the llm-proxy's prefill-ETA admission guard refuses local admission it
 * answers with HTTP `429` and a machine-readable body carrying
 * `code: local_admission_reject` and the message "Local admission refused".
 * The status code alone made {@link classifyError} classify it as
 * {@link ErrorCategory.RATE_LIMIT} (terminal), so a time-healable capacity
 * signal abandoned the turn instead of waiting out the `Retry-After` hint.
 *
 * These patterns identify the *refusal*; whether it is retryable is decided
 * separately by {@link isRetryableLocalAdmissionRefusal} from the body's
 * `retryable` flag / `Retry-After` hint, because the same guard also returns
 * refusals that waiting can never heal (`prefill_budget_exceeded`,
 * `context_too_large`).
 */
export const LOCAL_ADMISSION_REFUSAL_PATTERNS: RegExp[] = [
  /local_admission_reject/i,
  /local\s+admission\s+refused/i,
];

/**
 * Explicit `"retryable": false` on a refusal body. Authoritative: it wins
 * over any `Retry-After` hint in the same body, because the proxy only sets
 * the flag for reasons waiting cannot heal (compaction is required instead).
 * Tolerates the escaped-JSON form some SDKs fold into `error.message`
 * (`\"retryable\": false`).
 */
const NON_RETRYABLE_REFUSAL_FLAG = /["\\]*retryable["\\]*\s*:\s*false/i;

/** Explicit `"retryable": true` on a refusal body. */
const RETRYABLE_REFUSAL_FLAG = /["\\]*retryable["\\]*\s*:\s*true/i;

/**
 * A `Retry-After` / `retry_after` hint (header echo or body field) — the
 * proxy's other signal that the refusal is time-healable.
 */
const RETRY_HINT_PATTERN = /["\\]*retry["\\]*[-_]?after/i;

const DEFAULT_SERVER_ERROR_PATTERNS: RegExp[] = [
  /5\d{2}/,
  /server\s*error/i,
  /internal\s*(server\s*)?error/i,
  /service\s*unavailable/i,
  /overloaded/i,
  /retry\s*delay/i,
  /bad\s*gateway/i,
  /server\s*encountered/i,
  ...EXHAUSTION_SERVER_ERROR_PATTERNS,
  // pi-ai mapStopReason() collapses the enriched finish_reason payload to
  // the generic string "Provider finish_reason: error", discarding type/
  // message/suggested_action. Classify as server-error so the recovery loop
  // retries with exponential backoff rather than losing a long task
  // (WL-0MUQO8AEE003G1Z2).  Note: suggested_action is forwarded on the wire
  // but mapStopReason() currently drops it — see upstream tracking at
  // LP-0MUI5B98B0080CIB.
  /finish_reason:\s*error/i,
  /provider finish_reason:\s*error/i,
];

const DEFAULT_AUTH_ERROR_PATTERNS: RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /forbidden/i,
  /invalid\s*api\s*key/i,
  /authentication\s*failed/i,
  /api\s*key\s*(not\s*found|missing|revoked|has\s*been\s*revoked)/i,
  /invalid\s*authentication/i,
];

const DEFAULT_CONTEXT_LENGTH_PATTERNS: RegExp[] = [
  /context\s*length\s*(exceeded|limit)/i,
  /maximum\s*context\s*length/i,
  /max.*tokens/i,
  /token\s*limit\s*(exceeded|reached)/i,
  /too\s*many\s*tokens/i,
];

const DEFAULT_QUOTA_PATTERNS: RegExp[] = [
  /not\s*enough\s*credits/i,
  /insufficient\s*credits/i,
  /insufficient\s*balance/i,
  /out\s*of\s*credits/i,
  /quota\s*(exhausted|exceeded)/i,
  /payment\s*required/i,
  /\b402\b/,
];

const DEFAULT_TIMEOUT_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed?\s*out/i,
  /connection\s*error/i,
  /connection\s*refused/i,
  /network\s*error/i,
  /fetch\s*failed/i,
  /socket\s*(hang\s*up|error|timeout)/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /enotfound/i,
  /dns\s*lookup\s*failed/i,
  /upstream\s*connect/i,
  /broken\s*pipe/i,
  /request\s*(timeout|ended\s*without)/i,
  /stream\s+ended\s+without\s+finish/i, // stream dropped mid-generation (e.g., "Stream ended without finish_reason")
  /max\s*outbound\s*streams/i,
  /streams?\s*(exhausted|limit)/i,
];

const DEFAULT_TERMINATED_PATTERNS: RegExp[] = [
  /terminated/i,
  /content.filter/i,
  /content_filter/i,
  /blocked\s*by\s*content/i,
  /flagged\s*(and\s*)?blocked/i,
  /cannot\s*continue\s*from\s*message\s*role/i,
  /model\s*(not\s*found|does\s*not\s*exist)/i,
  /unknown\s*model/i,
  /unsupported\s*model/i,
  /no\s*such\s*model/i,
];

const DEFAULT_COMPACTION_GATE_PATTERNS: RegExp[] = [
  /compaction\s*gate/i, // wire-contract signal keyword (X-Compaction-Gate)
  /x-compaction-gate/i, // wire-contract header name echoed in the body
  /\b413\b/i, // wire-contract status code (Payload Too Large)
  /payload\s*too\s*large/i, // 413 reason phrase
  /request\s*too\s*large/i, // common 413 phrasing
  /cheap.*mode.*(cap|limit)/i, // cheap-mode proxy hard-cap signal
];

const DEFAULT_PARSE_ERROR_PATTERNS: RegExp[] = [
  // V8 / Node.js JSON.parse messages
  /expected\s+['\"]|['\"]\s+after\s+property\s+value/i,
  /unexpected\s+end\s+of\s+json\s+input/i,
  /unexpected\s+token/i,
  /unexpected\s+number\s+in\s+json/i,
  /unexpected\s+string\s+in\s+json/i,
  /unexpected\s+non-whitespace\s+character\s+after\s+json/i,
  /unterminated\s+string\s+in\s+json/i,
  /bad\s+control\s+character\s+in\s+string\s+literal\s+in\s+json/i,
  /json\s+parse\s+error/i,
  // Python json.JSONDecodeError texts
  /expecting\s+value/i,
  /expecting\s+','\s*delimiter/i,
  /expecting\s+':'\s*delimiter/i,
  /expecting\s+property\s+name\s+enclosed\s+in\s+double\s+quotes/i,
  /unterminated\s+string\s+starting\s+at/i,
  /invalid\s+control\s+character\s+at/i,
  /extra\s+data/i,
  /json\s+decode\s+error/i,
  // Generic JSON parse mentions
  /invalid\s+json/i,
  /json\.parse/i,
];

// ── Default config ────────────────────────────────────────────────────

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  rateLimit: {
    enabled: false,
    patterns: DEFAULT_RATE_LIMIT_PATTERNS,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
  serverError: {
    enabled: true,
    patterns: DEFAULT_SERVER_ERROR_PATTERNS,
    baseDelayMs: 2000,
    maxDelayMs: 600000, // 10-minute ceiling, aligned with DEFAULT_BACKOFF_CONFIG (WL-0MUY9GDPG0062NWF)
  },
  authError: {
    enabled: false,
    patterns: DEFAULT_AUTH_ERROR_PATTERNS,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
  contextLength: {
    enabled: true,
    patterns: DEFAULT_CONTEXT_LENGTH_PATTERNS,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    continuationPrompt: 'Please continue from where you left off.',
  },
  quotaExhausted: {
    enabled: false,
    patterns: DEFAULT_QUOTA_PATTERNS,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
  timeout: {
    enabled: true,
    patterns: DEFAULT_TIMEOUT_PATTERNS,
    baseDelayMs: 2000,
    maxDelayMs: 600000, // 10-minute ceiling, aligned with DEFAULT_BACKOFF_CONFIG (WL-0MUY9GDPG0062NWF)
  },
  terminated: {
    enabled: false,
    patterns: DEFAULT_TERMINATED_PATTERNS,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
  parseError: {
    enabled: true,
    patterns: DEFAULT_PARSE_ERROR_PATTERNS,
    baseDelayMs: 0,
    maxDelayMs: 0,
    continuationPrompt: 'continue',
  },
  compactionGate: {
    enabled: true,
    patterns: DEFAULT_COMPACTION_GATE_PATTERNS,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    continuationPrompt: 'Please continue from where you left off.',
  },
  // Bounded default cooldown for the durable model-cooldown marker
  // (WL-0MV5639X70029BOI). The default matches the retry-loop exponential
  // ceiling (WL-0MUY9GDPG0062NWF); the floor prevents a zero hold; the
  // ceiling reuses the 6-hour server-hint bound (WL-0MUR5EGH7003VOHM) so a
  // malformed or absurd hint can never pin the cooldown open.
  cooldown: {
    defaultMs: 600000, // 10 min — aligns with serverError/timeout maxDelayMs
    floorMs: 1000, // 1 s — never a zero hold
    ceilingMs: 6 * 60 * 60 * 1000, // 6 h — aligns with DEFAULT_SERVER_HINT_MAX_DELAY_MS
  },
};

// ── Match helper ──────────────────────────────────────────────────────

/**
 * Check if an error message matches any of the given patterns.
 */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Check if a message has stopReason "length" (model reached max tokens).
 * This is a special case that triggers compact-and-continue even if the
 * errorMessage patterns don't match.
 */
function hasLengthStop(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  return m.role === 'assistant' && m.stopReason === 'length';
}

// ── Per-category classifiers ─────────────────────────────────────────

export function isRateLimit(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, DEFAULT_RATE_LIMIT_PATTERNS);
}

export function isServerError(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, DEFAULT_SERVER_ERROR_PATTERNS);
}

/**
 * True when the message is a provider-exhaustion SERVER_ERROR — one of the
 * model-unavailable bodies (all providers exhausted/unavailable, no provider
 * available during the scheduled window). This is the narrower trigger for
 * the durable model-cooldown marker: unlike {@link isServerError}, a plain
 * retryable 5xx or a timeout returns false (WL-0MV5638J1006URXA).
 */
export function isExhaustionServerError(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, EXHAUSTION_SERVER_ERROR_PATTERNS);
}

/**
 * True when the message is an llm-proxy **local-admission refusal** — the
 * prefill-ETA admission guard declining to admit the prompt onto a contended
 * local slot (`local_admission_reject` / "Local admission refused").
 *
 * This says nothing about retryability: the same guard refuses prompts that
 * can never be admitted without compaction. Use
 * {@link isRetryableLocalAdmissionRefusal} for the retry decision
 * (WL-0MVSBF5XZ001H7V7).
 */
export function isLocalAdmissionRefusal(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, LOCAL_ADMISSION_REFUSAL_PATTERNS);
}

/**
 * True when a local-admission refusal is **time-healable** and must be
 * retried rather than treated as terminal (WL-0MVSBF5XZ001H7V7).
 *
 * A refusal is retryable when its body carries an explicit `"retryable":
 * true` or a `Retry-After` / `retry_after` hint, and is **not** retryable when
 * it carries an explicit `"retryable": false` (which wins over any hint).
 * A refusal with neither signal stays terminal, matching the pre-existing
 * behaviour — the proxy always marks this class of refusal explicitly, so an
 * unmarked body is not assumed to be resumable.
 */
export function isRetryableLocalAdmissionRefusal(message: unknown): boolean {
  if (!isLocalAdmissionRefusal(message)) return false;
  const text = (message as { errorMessage: string }).errorMessage;
  if (NON_RETRYABLE_REFUSAL_FLAG.test(text)) return false;
  return RETRYABLE_REFUSAL_FLAG.test(text) || RETRY_HINT_PATTERN.test(text);
}

export function isAuthError(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, DEFAULT_AUTH_ERROR_PATTERNS);
}

export function isContextLengthExceeded(message: unknown): boolean {
  // stopReason "length" is always context-length exceeded
  if (hasLengthStop(message)) return true;
  // Also check error message patterns for providers that report it differently
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, DEFAULT_CONTEXT_LENGTH_PATTERNS);
}

export function isQuotaExhausted(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, DEFAULT_QUOTA_PATTERNS);
}

export function isTimeout(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, DEFAULT_TIMEOUT_PATTERNS);
}

export function isTerminated(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, DEFAULT_TERMINATED_PATTERNS);
}

export function isParseError(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, DEFAULT_PARSE_ERROR_PATTERNS);
}

export function isCompactionGate(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return matchesAny(message.errorMessage, DEFAULT_COMPACTION_GATE_PATTERNS);
}

// ── Unified classifier ────────────────────────────────────────────────

/**
 * Classify an assistant message into one of the error categories.
 *
 * Checks are ordered by specificity (more specific matchers first).
 * Context-length is checked before timeout/terminated because it has
 * a special stopReason check. Terminated is checked last because it's
 * the broadest catch-all for "can't continue" errors.
 *
 * @param message - The assistant message to classify
 * @returns The detected ErrorCategory, or UNKNOWN if no patterns match
 */
export function classifyError(message: unknown): ErrorCategory {
  if (!message || typeof message !== 'object') return ErrorCategory.UNKNOWN;

  try {
    // Local-admission refusal is proxy **capacity backpressure**, not a rate
    // limit: the wire status is 429, but the guard marks the time-healable
    // case retryable and hands back a `Retry-After` hint the retry loop
    // already honours. Checked before every other category so the generic
    // `\b429\b` rate-limit pattern cannot win (WL-0MVSBF5XZ001H7V7); a
    // refusal that waiting cannot heal (`retryable: false`) stays terminal
    // so it never burns backoff on a request that needs compaction.
    if (isLocalAdmissionRefusal(message)) {
      return isRetryableLocalAdmissionRefusal(message)
        ? ErrorCategory.SERVER_ERROR
        : ErrorCategory.TERMINATED;
    }
    // Compaction gate is a proxy-level 4xx signal, distinct from the
    // model-level context-length signal (stopReason "length"). Gate
    // keywords must win over generic context-length patterns so the two
    // never conflate (WL-0MTBOXEGR009KDP6).
    if (isCompactionGate(message)) return ErrorCategory.COMPACTION_GATE;
    // Check for context-length second (special stopReason check)
    if (isContextLengthExceeded(message)) return ErrorCategory.CONTEXT_LENGTH;
    if (isRateLimit(message)) return ErrorCategory.RATE_LIMIT;
    if (isAuthError(message)) return ErrorCategory.AUTH_ERROR;
    if (isQuotaExhausted(message)) return ErrorCategory.QUOTA_EXHAUSTED;
    if (isTimeout(message)) return ErrorCategory.TIMEOUT;
    if (isServerError(message)) return ErrorCategory.SERVER_ERROR;
    if (isTerminated(message)) return ErrorCategory.TERMINATED;
    if (isParseError(message)) return ErrorCategory.PARSE_ERROR;

    return ErrorCategory.UNKNOWN;
  } catch {
    // Graceful degradation: any unexpected error during classification
    // should not crash the recovery module
    return ErrorCategory.UNKNOWN;
  }
}

/**
 * Get the default patterns for a given category.
 * Used when no user-configured patterns override exists.
 */
export function getDefaultPatterns(category: ErrorCategory): RegExp[] {
  switch (category) {
    case ErrorCategory.RATE_LIMIT: return DEFAULT_RATE_LIMIT_PATTERNS;
    case ErrorCategory.SERVER_ERROR: return DEFAULT_SERVER_ERROR_PATTERNS;
    case ErrorCategory.AUTH_ERROR: return DEFAULT_AUTH_ERROR_PATTERNS;
    case ErrorCategory.CONTEXT_LENGTH: return DEFAULT_CONTEXT_LENGTH_PATTERNS;
    case ErrorCategory.QUOTA_EXHAUSTED: return DEFAULT_QUOTA_PATTERNS;
    case ErrorCategory.TIMEOUT: return DEFAULT_TIMEOUT_PATTERNS;
    case ErrorCategory.TERMINATED: return DEFAULT_TERMINATED_PATTERNS;
    case ErrorCategory.PARSE_ERROR: return DEFAULT_PARSE_ERROR_PATTERNS;
    case ErrorCategory.COMPACTION_GATE: return DEFAULT_COMPACTION_GATE_PATTERNS;
    default: return [];
  }
}
