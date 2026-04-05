/**
 * Unit tests for src/lib/ingestion/extractor.ts
 *
 * The Extractor interface and ExtractResult type are structural contracts;
 * these tests verify they are exported with the expected shape.
 */

import { describe, it, expect } from 'vitest';
import type { Extractor, ExtractResult } from '../../../src/lib/ingestion/extractor.js';

describe('Extractor interface', () => {
  it('can be implemented by a simple stub', async () => {
    const stub: Extractor = {
      async extract(url: string): Promise<ExtractResult> {
        return { text: 'hello', url };
      },
    };

    const result = await stub.extract('https://example.com');
    expect(result.text).toBe('hello');
    expect(result.url).toBe('https://example.com');
  });

  it('ExtractResult has the expected fields', () => {
    const result: ExtractResult = {
      text: 'content',
      html: '<p>content</p>',
      title: 'Page title',
      url: 'https://example.com',
    };

    expect(result.text).toBe('content');
    expect(result.html).toBe('<p>content</p>');
    expect(result.title).toBe('Page title');
    expect(result.url).toBe('https://example.com');
  });

  it('ExtractResult html and title fields are optional', () => {
    const result: ExtractResult = {
      text: 'content',
      url: 'https://example.com',
    };

    expect(result.html).toBeUndefined();
    expect(result.title).toBeUndefined();
  });
});
