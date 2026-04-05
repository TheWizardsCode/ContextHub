/**
 * Ingestion service with Playwright fallback orchestration.
 *
 * Orchestrates URL content retrieval using a fast primary extractor and an
 * optional Playwright-based fallback for JavaScript-heavy pages.
 *
 * The fallback is opt-in: it is only activated when:
 *   1. `config.playwrightFallback` is `true` (or the `OB_PLAYWRIGHT_FALLBACK`
 *      environment variable is set to a truthy value), AND
 *   2. The primary extractor returns fewer characters than
 *      `config.minContentLength` (default: 200).
 *
 * On every invocation, a structured telemetry entry is emitted via the
 * provided logger.  Telemetry never includes URL text, page content, or any
 * user-identifiable data.
 */

import type { Extractor, ExtractResult } from './extractor.js';

/** Configuration for the ingestion service. */
export interface IngestionConfig {
  /**
   * Enable the Playwright fallback extractor.
   *
   * Can also be enabled by setting the `OB_PLAYWRIGHT_FALLBACK` environment
   * variable to any truthy value (`1`, `true`, `yes`).
   *
   * @default false
   */
  playwrightFallback?: boolean;

  /**
   * Minimum character count that primary extractor content must reach before
   * the Playwright fallback is considered unnecessary.
   *
   * @default 200
   */
  minContentLength?: number;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** Structured telemetry entry emitted on every ingestion run. */
export interface PlaywrightFallbackTelemetry {
  /** Fixed event identifier. */
  event: 'playwright_fallback';
  /** Whether the fallback was actually triggered. */
  triggered: boolean;
  /** Character count returned by the primary extractor. */
  primaryContentLength: number;
  /** Character count returned by PlaywrightExtractor (0 if not triggered or failed). */
  fallbackContentLength: number;
  /** Wall-clock time of the Playwright fetch in milliseconds (0 if not triggered). */
  durationMs: number;
  /** Whether PlaywrightExtractor returned usable content. */
  success: boolean;
  /** Error classification, or null when no error occurred. */
  errorType: 'launch_failed' | 'timeout' | 'navigation_error' | null;
  /** Always "playwright" for this fallback. */
  provider: 'playwright';
}

/** Minimal logger interface used by the service. */
export interface ServiceLogger {
  info: (message: string, meta?: PlaywrightFallbackTelemetry) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// IngestionService
// ---------------------------------------------------------------------------

const DEFAULT_MIN_CONTENT_LENGTH = 200;

/**
 * Determines whether the Playwright fallback is enabled, considering both the
 * programmatic config and the `OB_PLAYWRIGHT_FALLBACK` environment variable.
 */
function isFallbackEnabled(config: IngestionConfig): boolean {
  if (config.playwrightFallback === true) return true;
  const envVal = process.env['OB_PLAYWRIGHT_FALLBACK'];
  return envVal === '1' || envVal === 'true' || envVal === 'yes';
}

/**
 * Service that orchestrates URL ingestion with an optional Playwright
 * fallback for JavaScript-heavy pages.
 */
export class IngestionService {
  private readonly primaryExtractor: Extractor;
  private readonly playwrightExtractor: Extractor;
  private readonly config: IngestionConfig;
  private readonly logger: ServiceLogger;

  constructor(
    primaryExtractor: Extractor,
    playwrightExtractor: Extractor,
    config: IngestionConfig = {},
    logger?: ServiceLogger
  ) {
    this.primaryExtractor = primaryExtractor;
    this.playwrightExtractor = playwrightExtractor;
    this.config = config;
    this.logger = logger ?? {
      info: (msg, meta) => {
        const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
        process.stdout.write(`${line}\n`);
      },
      warn: (msg, ...args) => {
        const parts = [msg, ...args.map(a => String(a))].join(' ');
        process.stderr.write(`${parts}\n`);
      },
    };
  }

  /**
   * Ingest content from `url`.
   *
   * 1. Runs the primary extractor.
   * 2. If the fallback is enabled and primary content is below the threshold,
   *    runs PlaywrightExtractor.
   * 3. Emits a telemetry entry regardless of which path was taken.
   * 4. Returns the best available result (fallback if it produced content,
   *    otherwise the primary result).
   *
   * @param url The URL to ingest.
   * @returns The best {@link ExtractResult} available.
   */
  async ingest(url: string): Promise<ExtractResult> {
    const minLen =
      this.config.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH;

    const primaryResult = await this.primaryExtractor.extract(url);
    const primaryLen = primaryResult.text.length;

    if (!isFallbackEnabled(this.config) || primaryLen >= minLen) {
      this.emitTelemetry({
        event: 'playwright_fallback',
        triggered: false,
        primaryContentLength: primaryLen,
        fallbackContentLength: 0,
        durationMs: 0,
        success: false,
        errorType: null,
        provider: 'playwright',
      });
      return primaryResult;
    }

    // Fallback triggered.
    const startMs = Date.now();
    let fallbackResult: ExtractResult = { text: '', url };
    let errorType: PlaywrightFallbackTelemetry['errorType'] = null;

    try {
      fallbackResult = await this.playwrightExtractor.extract(url);
    } catch (err) {
      // PlaywrightExtractor should not throw, but guard anyway.
      this.logger.warn(
        '[IngestionService] Unexpected error from PlaywrightExtractor:',
        err instanceof Error ? err.message : err
      );
      errorType = 'navigation_error';
    }

    const durationMs = Date.now() - startMs;
    const fallbackLen = fallbackResult.text.length;
    const success = fallbackLen > 0;

    this.emitTelemetry({
      event: 'playwright_fallback',
      triggered: true,
      primaryContentLength: primaryLen,
      fallbackContentLength: fallbackLen,
      durationMs,
      success,
      errorType,
      provider: 'playwright',
    });

    return success ? fallbackResult : primaryResult;
  }

  private emitTelemetry(entry: PlaywrightFallbackTelemetry): void {
    this.logger.info('[telemetry]', entry);
  }
}
