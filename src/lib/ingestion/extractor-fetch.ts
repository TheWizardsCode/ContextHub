/**
 * Primary fast-path extractor.
 *
 * Fetches a URL using the built-in `fetch` API and extracts plain text by
 * stripping HTML tags.  This is the default extractor used by the ingestion
 * service; it is fast but cannot handle pages that render content with
 * client-side JavaScript.
 */

import type { Extractor, ExtractResult } from './extractor.js';

/** Configuration for the primary fetch-based extractor. */
export interface FetchExtractorConfig {
  /**
   * Request timeout in milliseconds.
   * @default 15000
   */
  timeoutMs?: number;
  /**
   * User-Agent string to send with requests.
   */
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; OpenBrain-Ingestion/1.0; +https://github.com/TheWizardsCode/ContextHub)';

/**
 * Strips HTML tags and collapses whitespace from `html`.
 * Returns the resulting plain text.
 */
export function htmlToText(html: string): string {
  // Remove script and style blocks entirely (allow attributes/whitespace before closing >).
  let text = html
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, ' ');
  // Replace block-level elements with newlines.
  text = text.replace(/<\/(p|div|li|h[1-6]|br|tr|td|th|blockquote)[^>]*>/gi, '\n');
  // Strip all remaining tags.
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common named HTML entities in a single pass to avoid double-decoding
  // (e.g. &amp;lt; must become &lt;, not <).
  // Note: numeric character references (e.g. &#65; or &#x41;) are intentionally
  // not decoded here since they are uncommon in plain-content pages and the
  // purpose of this extractor is fast-path text extraction, not full HTML parsing.
  text = text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (match) => {
    switch (match) {
      case '&amp;':  return '&';
      case '&lt;':   return '<';
      case '&gt;':   return '>';
      case '&quot;': return '"';
      case '&#39;':  return "'";
      case '&nbsp;': return ' ';
      default:       return match;
    }
  });
  // Collapse whitespace.
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extracts the content of the first `<title>` tag in `html`.
 */
export function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match ? match[1].trim() : undefined;
}

/**
 * Primary extractor that uses HTTP fetch + HTML-to-text conversion.
 *
 * This extractor is fast and has no external runtime dependencies.  It is
 * the default first-pass extractor used by the ingestion service before
 * attempting the Playwright fallback.
 */
export class FetchExtractor implements Extractor {
  private readonly config: Required<FetchExtractorConfig>;

  constructor(config: FetchExtractorConfig = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
    };
  }

  async extract(url: string): Promise<ExtractResult> {
    let html: string;

    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs
      );
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': this.config.userAgent },
        });
        html = await response.text();
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { text: '', url };
    }

    return {
      text: htmlToText(html),
      html,
      title: extractTitle(html),
      url,
    };
  }
}
