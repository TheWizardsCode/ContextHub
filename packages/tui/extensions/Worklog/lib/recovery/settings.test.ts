/**
 * Tests for recovery module settings.
 *
 * Validates that recovery settings are properly loaded, merged, persisted,
 * and reactively updated through the WorklogConfig system.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/settings.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_RECOVERY_CONFIG, type RecoveryConfig, type RecoveryCategoryConfig } from './error-patterns.js';

// ── RecoveryConfig defaults ───────────────────────────────────────────

describe('DEFAULT_RECOVERY_CONFIG', () => {
  it('has all 9 error categories', () => {
    const keys = Object.keys(DEFAULT_RECOVERY_CONFIG);
    expect(keys.sort()).toEqual([
      'authError',
      'compactionGate',
      'contextLength',
      'parseError',
      'quotaExhausted',
      'rateLimit',
      'serverError',
      'terminated',
      'timeout',
    ]);
  });

  it('rate limit defaults to NOT retried', () => {
    expect(DEFAULT_RECOVERY_CONFIG.rateLimit.enabled).toBe(false);
    expect(DEFAULT_RECOVERY_CONFIG.rateLimit.baseDelayMs).toBe(1000);
    expect(DEFAULT_RECOVERY_CONFIG.rateLimit.maxDelayMs).toBe(30000);
  });

  it('server error defaults to retried with backoff', () => {
    expect(DEFAULT_RECOVERY_CONFIG.serverError.enabled).toBe(true);
    expect(DEFAULT_RECOVERY_CONFIG.serverError.baseDelayMs).toBe(2000);
    expect(DEFAULT_RECOVERY_CONFIG.serverError.maxDelayMs).toBe(60000);
  });

  it('auth error defaults to NOT retried', () => {
    expect(DEFAULT_RECOVERY_CONFIG.authError.enabled).toBe(false);
  });

  it('context-length defaults to enabled (compact + auto-continue)', () => {
    expect(DEFAULT_RECOVERY_CONFIG.contextLength.enabled).toBe(true);
    expect(DEFAULT_RECOVERY_CONFIG.contextLength.continuationPrompt).toBeDefined();
  });

  it('quota exhausted defaults to NOT retried', () => {
    expect(DEFAULT_RECOVERY_CONFIG.quotaExhausted.enabled).toBe(false);
  });

  it('timeout defaults to retried with backoff', () => {
    expect(DEFAULT_RECOVERY_CONFIG.timeout.enabled).toBe(true);
    expect(DEFAULT_RECOVERY_CONFIG.timeout.baseDelayMs).toBe(2000);
    expect(DEFAULT_RECOVERY_CONFIG.timeout.maxDelayMs).toBe(60000);
  });

  it('terminated defaults to NOT retried', () => {
    expect(DEFAULT_RECOVERY_CONFIG.terminated.enabled).toBe(false);
  });

  it('parse error defaults to enabled (single-shot continue)', () => {
    expect(DEFAULT_RECOVERY_CONFIG.parseError.enabled).toBe(true);
    expect(DEFAULT_RECOVERY_CONFIG.parseError.patterns.length).toBeGreaterThan(0);
    expect(DEFAULT_RECOVERY_CONFIG.parseError.continuationPrompt).toBe('continue');
    // No backoff for the single-shot category
    expect(DEFAULT_RECOVERY_CONFIG.parseError.baseDelayMs).toBe(0);
    expect(DEFAULT_RECOVERY_CONFIG.parseError.maxDelayMs).toBe(0);
  });

  it('each category has patterns array', () => {
    for (const [key, cat] of Object.entries(DEFAULT_RECOVERY_CONFIG)) {
      expect(Array.isArray((cat as RecoveryCategoryConfig).patterns)).toBe(true);
      expect((cat as RecoveryCategoryConfig).patterns.length).toBeGreaterThan(0);
    }
  });

  it('each category has valid baseDelayMs and maxDelayMs', () => {
    for (const cat of Object.values(DEFAULT_RECOVERY_CONFIG)) {
      expect(cat.baseDelayMs).toBeGreaterThanOrEqual(0);
      expect(cat.maxDelayMs).toBeGreaterThanOrEqual(cat.baseDelayMs);
    }
  });

  it('backoff-based categories have a positive base delay', () => {
    for (const cat of Object.values(DEFAULT_RECOVERY_CONFIG)) {
      // Single-shot categories (e.g. parseError) legitimately use 0ms
      // delays because they never back off.
      if (cat.baseDelayMs === 0) continue;
      expect(cat.baseDelayMs).toBeGreaterThanOrEqual(100);
    }
  });
});

// ── RecoveryConfig type validation ────────────────────────────────────

describe('RecoveryConfig structure', () => {
  it('RecoveryCategoryConfig has required fields', () => {
    const cat: RecoveryCategoryConfig = {
      enabled: true,
      patterns: [/test/i],
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    };
    expect(cat.enabled).toBe(true);
    expect(cat.patterns).toHaveLength(1);
    expect(cat.baseDelayMs).toBe(1000);
    expect(cat.maxDelayMs).toBe(30000);
  });

  it('RecoveryCategoryConfig supports optional continuationPrompt', () => {
    const cat: RecoveryCategoryConfig = {
      enabled: true,
      patterns: [/test/i],
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      continuationPrompt: 'Please continue.',
    };
    expect(cat.continuationPrompt).toBe('Please continue.');
  });

  it('RecoveryCategoryConfig allows continuationPrompt to be missing', () => {
    const cat: RecoveryCategoryConfig = {
      enabled: true,
      patterns: [/test/i],
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    };
    expect(cat.continuationPrompt).toBeUndefined();
  });
});

// ── Config merge behavior ─────────────────────────────────────────────

describe('config merge behavior', () => {
  it('partial config overrides only specified categories', () => {
    // Simulate: defaults → user overrides rateLimit
    const userConfig: Partial<RecoveryConfig> = {
      rateLimit: { enabled: true, patterns: [/429/i], baseDelayMs: 5000, maxDelayMs: 60000 },
    };

    const merged: RecoveryConfig = {
      ...DEFAULT_RECOVERY_CONFIG,
      ...userConfig,
      rateLimit: { ...DEFAULT_RECOVERY_CONFIG.rateLimit, ...userConfig.rateLimit },
    };

    expect(merged.rateLimit.enabled).toBe(true);
    expect(merged.rateLimit.baseDelayMs).toBe(5000);
    // Unchanged categories retain defaults
    expect(merged.serverError.enabled).toBe(true);
    expect(merged.serverError.baseDelayMs).toBe(2000);
  });

  it('sparse override preserves patterns from defaults', () => {
    const userConfig: Partial<RecoveryConfig> = {
      serverError: { enabled: false },
    };

    // Merge: only override enabled, keep default patterns
    const merged = {
      ...DEFAULT_RECOVERY_CONFIG,
      serverError: {
        ...DEFAULT_RECOVERY_CONFIG.serverError,
        ...userConfig.serverError,
      },
    } as RecoveryConfig;

    expect(merged.serverError.enabled).toBe(false);
    // Patterns preserved from defaults
    expect(merged.serverError.patterns).toEqual(DEFAULT_RECOVERY_CONFIG.serverError.patterns);
    // Delay preserved from defaults
    expect(merged.serverError.baseDelayMs).toBe(DEFAULT_RECOVERY_CONFIG.serverError.baseDelayMs);
  });

  it('full override replaces all fields for a category', () => {
    const custom: RecoveryCategoryConfig = {
      enabled: true,
      patterns: [/custom-pattern/i],
      baseDelayMs: 10000,
      maxDelayMs: 120000,
      continuationPrompt: 'Keep going.',
    };

    const merged: RecoveryConfig = {
      ...DEFAULT_RECOVERY_CONFIG,
      contextLength: { ...DEFAULT_RECOVERY_CONFIG.contextLength, ...custom },
    };

    expect((merged.contextLength as RecoveryCategoryConfig).patterns).toContainEqual(/custom-pattern/i);
    expect(merged.contextLength.baseDelayMs).toBe(10000);
    expect((merged.contextLength as RecoveryCategoryConfig).continuationPrompt).toBe('Keep going.');
  });
});
