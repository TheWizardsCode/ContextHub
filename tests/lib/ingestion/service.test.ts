/**
 * Unit tests for src/lib/ingestion/service.ts
 *
 * Covers:
 * - Primary-only path (fallback disabled or threshold not met)
 * - Fallback trigger (short primary content + enabled flag)
 * - Fallback via OB_PLAYWRIGHT_FALLBACK env var
 * - Fallback returns empty → primary result is returned
 * - Telemetry emission on every invocation
 * - Graceful handling when PlaywrightExtractor throws unexpectedly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IngestionService, type IngestionConfig, type PlaywrightFallbackTelemetry } from '../../../src/lib/ingestion/service.js';
import type { Extractor, ExtractResult } from '../../../src/lib/ingestion/extractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExtractor(result: ExtractResult): Extractor {
  return { extract: vi.fn(async () => result) };
}

function makeResult(text: string, url = 'https://example.com'): ExtractResult {
  return { text, url };
}

function capturedTelemetry(
  infoSpy: ReturnType<typeof vi.fn>
): PlaywrightFallbackTelemetry | undefined {
  const call = infoSpy.mock.calls.find(
    (c: unknown[]) => c[0] === '[telemetry]'
  );
  return call ? (call[1] as PlaywrightFallbackTelemetry) : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IngestionService', () => {
  const URL = 'https://example.com';
  let infoSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.fn>;
  let logger: { info: typeof infoSpy; warn: typeof warnSpy };

  beforeEach(() => {
    infoSpy = vi.fn();
    warnSpy = vi.fn();
    logger = { info: infoSpy, warn: warnSpy };
    // Ensure env var is not set between tests.
    delete process.env['OB_PLAYWRIGHT_FALLBACK'];
  });

  afterEach(() => {
    delete process.env['OB_PLAYWRIGHT_FALLBACK'];
  });

  // -------------------------------------------------------------------------
  // Fallback disabled
  // -------------------------------------------------------------------------

  it('returns primary result when fallback is disabled (default)', async () => {
    const primary = makeExtractor(makeResult('short', URL));
    const pw = makeExtractor(makeResult('playwright content', URL));

    const svc = new IngestionService(primary, pw, {}, logger);
    const result = await svc.ingest(URL);

    expect(result.text).toBe('short');
    expect(pw.extract).not.toHaveBeenCalled();
  });

  it('returns primary result when fallback is disabled explicitly', async () => {
    const primary = makeExtractor(makeResult('short', URL));
    const pw = makeExtractor(makeResult('playwright content', URL));

    const svc = new IngestionService(
      primary, pw, { playwrightFallback: false }, logger
    );
    const result = await svc.ingest(URL);

    expect(result.text).toBe('short');
    expect(pw.extract).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Fallback not triggered (primary content is sufficient)
  // -------------------------------------------------------------------------

  it('does not trigger fallback when primary content meets threshold', async () => {
    const longText = 'a'.repeat(300);
    const primary = makeExtractor(makeResult(longText, URL));
    const pw = makeExtractor(makeResult('playwright content', URL));

    const svc = new IngestionService(
      primary, pw, { playwrightFallback: true, minContentLength: 200 }, logger
    );
    const result = await svc.ingest(URL);

    expect(result.text).toBe(longText);
    expect(pw.extract).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Fallback triggered
  // -------------------------------------------------------------------------

  it('triggers fallback when primary content is below threshold', async () => {
    const primary = makeExtractor(makeResult('too short', URL));
    const pw = makeExtractor(makeResult('Rich playwright content that is long enough', URL));

    const svc = new IngestionService(
      primary, pw, { playwrightFallback: true, minContentLength: 200 }, logger
    );
    const result = await svc.ingest(URL);

    expect(result.text).toBe('Rich playwright content that is long enough');
    expect(pw.extract).toHaveBeenCalledWith(URL);
  });

  it('returns primary result when fallback also returns empty', async () => {
    const primary = makeExtractor(makeResult('short', URL));
    const pw = makeExtractor(makeResult('', URL));

    const svc = new IngestionService(
      primary, pw, { playwrightFallback: true, minContentLength: 200 }, logger
    );
    const result = await svc.ingest(URL);

    expect(result.text).toBe('short');
  });

  // -------------------------------------------------------------------------
  // Environment variable activation
  // -------------------------------------------------------------------------

  it('activates fallback via OB_PLAYWRIGHT_FALLBACK=1', async () => {
    process.env['OB_PLAYWRIGHT_FALLBACK'] = '1';
    const primary = makeExtractor(makeResult('short', URL));
    const pw = makeExtractor(makeResult('playwright result', URL));

    const svc = new IngestionService(primary, pw, {}, logger);
    const result = await svc.ingest(URL);

    expect(result.text).toBe('playwright result');
    expect(pw.extract).toHaveBeenCalled();
  });

  it('activates fallback via OB_PLAYWRIGHT_FALLBACK=true', async () => {
    process.env['OB_PLAYWRIGHT_FALLBACK'] = 'true';
    const primary = makeExtractor(makeResult('short', URL));
    const pw = makeExtractor(makeResult('playwright result', URL));

    const svc = new IngestionService(primary, pw, {}, logger);
    const result = await svc.ingest(URL);

    expect(result.text).toBe('playwright result');
  });

  it('does not activate fallback via OB_PLAYWRIGHT_FALLBACK=0', async () => {
    process.env['OB_PLAYWRIGHT_FALLBACK'] = '0';
    const primary = makeExtractor(makeResult('short', URL));
    const pw = makeExtractor(makeResult('playwright result', URL));

    const svc = new IngestionService(primary, pw, {}, logger);
    const result = await svc.ingest(URL);

    expect(result.text).toBe('short');
    expect(pw.extract).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Telemetry
  // -------------------------------------------------------------------------

  it('emits telemetry with triggered=false when fallback is disabled', async () => {
    const primary = makeExtractor(makeResult('some text', URL));
    const pw = makeExtractor(makeResult('', URL));

    const svc = new IngestionService(primary, pw, {}, logger);
    await svc.ingest(URL);

    const telemetry = capturedTelemetry(infoSpy);
    expect(telemetry).toBeDefined();
    expect(telemetry!.event).toBe('playwright_fallback');
    expect(telemetry!.triggered).toBe(false);
    expect(telemetry!.primaryContentLength).toBe('some text'.length);
    expect(telemetry!.fallbackContentLength).toBe(0);
    expect(telemetry!.durationMs).toBe(0);
    expect(telemetry!.success).toBe(false);
    expect(telemetry!.errorType).toBeNull();
    expect(telemetry!.provider).toBe('playwright');
  });

  it('emits telemetry with triggered=true when fallback runs', async () => {
    const primary = makeExtractor(makeResult('short', URL));
    const fallbackText = 'long fallback content from playwright';
    const pw = makeExtractor(makeResult(fallbackText, URL));

    const svc = new IngestionService(
      primary, pw, { playwrightFallback: true }, logger
    );
    await svc.ingest(URL);

    const telemetry = capturedTelemetry(infoSpy);
    expect(telemetry!.triggered).toBe(true);
    expect(telemetry!.primaryContentLength).toBe('short'.length);
    expect(telemetry!.fallbackContentLength).toBe(fallbackText.length);
    expect(telemetry!.success).toBe(true);
    expect(telemetry!.errorType).toBeNull();
    expect(telemetry!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits telemetry with success=false when fallback returns empty', async () => {
    const primary = makeExtractor(makeResult('tiny', URL));
    const pw = makeExtractor(makeResult('', URL));

    const svc = new IngestionService(
      primary, pw, { playwrightFallback: true }, logger
    );
    await svc.ingest(URL);

    const telemetry = capturedTelemetry(infoSpy);
    expect(telemetry!.triggered).toBe(true);
    expect(telemetry!.success).toBe(false);
    expect(telemetry!.fallbackContentLength).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Graceful handling of unexpected PlaywrightExtractor error
  // -------------------------------------------------------------------------

  it('handles unexpected PlaywrightExtractor throw gracefully', async () => {
    const primary = makeExtractor(makeResult('short', URL));
    const pw: Extractor = {
      extract: vi.fn(async () => { throw new Error('unexpected crash'); }),
    };

    const svc = new IngestionService(
      primary, pw, { playwrightFallback: true }, logger
    );
    // Must not throw.
    const result = await svc.ingest(URL);

    // Falls back to primary result.
    expect(result.text).toBe('short');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected error'),
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // Default minContentLength
  // -------------------------------------------------------------------------

  it('uses default minContentLength of 200 when not specified', async () => {
    // Text of exactly 199 chars → should trigger fallback.
    const shortText = 'a'.repeat(199);
    const primary = makeExtractor(makeResult(shortText, URL));
    const pw = makeExtractor(makeResult('playwright result', URL));

    const svc = new IngestionService(
      primary, pw, { playwrightFallback: true }, logger
    );
    const result = await svc.ingest(URL);

    expect(result.text).toBe('playwright result');
    expect(pw.extract).toHaveBeenCalled();
  });

  it('does not trigger fallback when text is exactly at default threshold (200 chars)', async () => {
    const atThreshold = 'a'.repeat(200);
    const primary = makeExtractor(makeResult(atThreshold, URL));
    const pw = makeExtractor(makeResult('playwright result', URL));

    const svc = new IngestionService(
      primary, pw, { playwrightFallback: true }, logger
    );
    const result = await svc.ingest(URL);

    expect(result.text).toBe(atThreshold);
    expect(pw.extract).not.toHaveBeenCalled();
  });
});
