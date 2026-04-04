/**
 * Unit tests for src/lib/ingestion/extractor-fetch.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { htmlToText, extractTitle, FetchExtractor } from '../../../src/lib/ingestion/extractor-fetch.js';

// ---------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------

describe('htmlToText', () => {
  it('strips HTML tags', () => {
    expect(htmlToText('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
  });

  it('removes script blocks entirely', () => {
    const html = '<p>Visible</p><script>var x = 1;</script><p>After</p>';
    const text = htmlToText(html);
    expect(text).not.toContain('var x');
    expect(text).toContain('Visible');
    expect(text).toContain('After');
  });

  it('removes style blocks entirely', () => {
    const html = '<p>Text</p><style>body { color: red; }</style>';
    const text = htmlToText(html);
    expect(text).not.toContain('color');
    expect(text).toContain('Text');
  });

  it('decodes common HTML entities', () => {
    // &nbsp; decodes to a regular space which is then trimmed by whitespace normalization.
    expect(htmlToText('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe("& < > \" '");
  });

  it('collapses whitespace', () => {
    expect(htmlToText('  hello   world  ')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

describe('extractTitle', () => {
  it('extracts a simple title', () => {
    expect(extractTitle('<html><head><title>My Page</title></head></html>')).toBe('My Page');
  });

  it('returns undefined when no title tag', () => {
    expect(extractTitle('<html><head></head></html>')).toBeUndefined();
  });

  it('trims whitespace from title', () => {
    expect(extractTitle('<title>  Spaces  </title>')).toBe('Spaces');
  });
});

// ---------------------------------------------------------------------------
// FetchExtractor
// ---------------------------------------------------------------------------

describe('FetchExtractor', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResponse(html: string) {
    return {
      ok: true,
      text: vi.fn(async () => html),
    };
  }

  it('returns extracted text from a successful fetch', async () => {
    const html = '<html><head><title>Test</title></head><body><p>Hello world</p></body></html>';
    mockFetch.mockResolvedValueOnce(mockResponse(html));

    const extractor = new FetchExtractor();
    const result = await extractor.extract('https://example.com');

    expect(result.url).toBe('https://example.com');
    expect(result.text).toContain('Hello world');
    expect(result.title).toBe('Test');
    expect(result.html).toBe(html);
  });

  it('returns empty text on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const extractor = new FetchExtractor();
    const result = await extractor.extract('https://unreachable.example.com');

    expect(result.text).toBe('');
    expect(result.url).toBe('https://unreachable.example.com');
  });

  it('returns empty text on abort (timeout)', async () => {
    mockFetch.mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    );

    const extractor = new FetchExtractor({ timeoutMs: 1 });
    const result = await extractor.extract('https://slow.example.com');

    expect(result.text).toBe('');
  });

  it('passes the User-Agent header', async () => {
    const html = '<p>content</p>';
    mockFetch.mockResolvedValueOnce(mockResponse(html));

    const extractor = new FetchExtractor({ userAgent: 'TestAgent/1.0' });
    await extractor.extract('https://example.com');

    const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>)['User-Agent']).toBe('TestAgent/1.0');
  });
});
