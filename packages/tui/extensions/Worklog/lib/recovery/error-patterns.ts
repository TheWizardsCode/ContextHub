/**
 * Error classification patterns for the recovery module.
 *
 * Ported and enhanced from pi-retry's error-patterns.ts. Provides
 * per-category detection with configurable regex patterns that can be
 * overridden via settings.
 *
 * Seven error categories are defined:
 * - Rate limits (429)        → NOT retried (informative error)
 * - Server errors (5xx)      → retried with configurable backoff
 * - Auth errors (401/403)    → NOT retried (checkpoint + terminal)
 * - Context-length exceeded  → /compact + auto-continue
 * - Quota exhausted          → NOT retried (checkpoint + terminal)
 * - Timeout                  → retried with configurable backoff
 * - Terminated               → NOT retried (checkpoint + terminal)
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

const DEFAULT_SERVER_ERROR_PATTERNS: RegExp[] = [
  /5\d{2}/,
  /server\s*error/i,
  /internal\s*(server\s*)?error/i,
  /service\s*unavailable/i,
  /overloaded/i,
  /retry\s*delay/i,
  /bad\s*gateway/i,
  /server\s*encountered/i,
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
    maxDelayMs: 60000,
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
    maxDelayMs: 60000,
  },
  terminated: {
    enabled: false,
    patterns: DEFAULT_TERMINATED_PATTERNS,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
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
    // Check for context-length first (special stopReason check)
    if (isContextLengthExceeded(message)) return ErrorCategory.CONTEXT_LENGTH;
    if (isRateLimit(message)) return ErrorCategory.RATE_LIMIT;
    if (isAuthError(message)) return ErrorCategory.AUTH_ERROR;
    if (isQuotaExhausted(message)) return ErrorCategory.QUOTA_EXHAUSTED;
    if (isTimeout(message)) return ErrorCategory.TIMEOUT;
    if (isServerError(message)) return ErrorCategory.SERVER_ERROR;
    if (isTerminated(message)) return ErrorCategory.TERMINATED;

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
    default: return [];
  }
}
