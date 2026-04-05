/**
 * Unit tests for src/cli/commands/add.ts
 *
 * Tests exercise the `runAdd` function using stubbed IngestionService
 * instances.  No real network requests or browser launches occur.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAdd } from '../../../src/cli/commands/add.js';
import * as serviceModule from '../../../src/lib/ingestion/service.js';
import type { ExtractResult } from '../../../src/lib/ingestion/extractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockIngestResult(text: string): ExtractResult {
  return { text, url: 'https://example.com' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAdd', () => {
  let ingestSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on IngestionService.prototype.ingest so we can control the result.
    ingestSpy = vi
      .spyOn(serviceModule.IngestionService.prototype, 'ingest')
      .mockResolvedValue(mockIngestResult('Ingested content'));

    // Capture stdout writes.
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes ingested content to stdout by default', async () => {
    await runAdd('https://example.com');

    expect(stdoutSpy).toHaveBeenCalledWith('Ingested content');
  });

  it('returns the ExtractResult', async () => {
    const result = await runAdd('https://example.com');
    expect(result.text).toBe('Ingested content');
    expect(result.url).toBe('https://example.com');
  });

  it('throws when URL is empty', async () => {
    await expect(runAdd('')).rejects.toThrow('URL is required');
  });

  it('passes playwrightFallback option to IngestionService', async () => {
    // We can inspect the IngestionService constructor call via the spy on ingest.
    await runAdd('https://example.com', { playwrightFallback: true });
    expect(ingestSpy).toHaveBeenCalledWith('https://example.com');
  });

  it('writes to output file when --output is specified', async () => {
    const writeFileSpy = vi.fn();

    await runAdd('https://example.com', {
      output: '/tmp/output.txt',
      _writeFile: writeFileSpy,
    });

    expect(writeFileSpy).toHaveBeenCalledWith('/tmp/output.txt', 'Ingested content', 'utf8');
    // Should not also write to stdout.
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('appends newline to stdout when content does not end with one', async () => {
    ingestSpy.mockResolvedValueOnce(mockIngestResult('No newline content'));
    const writes: string[] = [];
    stdoutSpy.mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    await runAdd('https://example.com');

    expect(writes.join('')).toMatch(/\n$/);
  });

  it('does not append extra newline when content already ends with one', async () => {
    ingestSpy.mockResolvedValueOnce(mockIngestResult('Content with newline\n'));
    const writes: string[] = [];
    stdoutSpy.mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    await runAdd('https://example.com');

    // Should be exactly one newline at the end, not two.
    const combined = writes.join('');
    expect(combined.endsWith('\n\n')).toBe(false);
    expect(combined.endsWith('\n')).toBe(true);
  });
});
