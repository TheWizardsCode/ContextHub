/**
 * Extractor interface for URL content retrieval.
 *
 * All extractors (primary fast-path and Playwright fallback) implement this
 * interface so they can be swapped in the ingestion pipeline without changes
 * to the service layer.
 */

/**
 * The result of extracting content from a URL.
 */
export interface ExtractResult {
  /** The plain-text content extracted from the page. */
  text: string;
  /** The raw HTML of the page (optional; used for downstream parsing). */
  html?: string;
  /** The page title, if available. */
  title?: string;
  /** The URL that was fetched (may differ from the requested URL after redirects). */
  url: string;
}

/**
 * Interface that all URL extractors must implement.
 */
export interface Extractor {
  /**
   * Fetch and extract content from the given URL.
   *
   * Implementations must not throw. Failures are surfaced via a result with
   * an empty `text` field (and optionally an error logged internally).
   *
   * @param url The URL to fetch.
   * @returns A promise resolving to the extracted content.
   */
  extract(url: string): Promise<ExtractResult>;
}
