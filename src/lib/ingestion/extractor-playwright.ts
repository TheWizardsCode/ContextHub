/**
 * Playwright-based fallback extractor.
 *
 * Uses a headless Chromium (or configured) browser to render JavaScript-heavy
 * pages that the primary fast-path extractor cannot handle.
 *
 * Design principles:
 * - Playwright is imported dynamically at runtime so the module does not fail
 *   to load when the `playwright` package is absent.
 * - Each invocation uses a fresh browser context to avoid credential leakage
 *   (no cookies, local storage, or auth tokens are shared between runs).
 * - All failures (launch error, navigation timeout, navigation error) are
 *   handled gracefully: the extractor returns an empty result and logs a
 *   warning rather than throwing.
 */

import type { Extractor, ExtractResult } from './extractor.js';

/** Playwright browser channel to launch. */
export type PlaywrightBrowserChannel = 'chromium' | 'firefox' | 'webkit';

/** Configuration for PlaywrightExtractor. */
export interface PlaywrightExtractorConfig {
  /**
   * Which browser to use.
   * @default 'chromium'
   */
  browser?: PlaywrightBrowserChannel;
  /**
   * Navigation timeout in milliseconds.
   * @default 30000
   */
  timeoutMs?: number;
}

/**
 * Classifies errors that the PlaywrightExtractor can encounter.
 * Used in telemetry payloads.
 */
export type PlaywrightErrorType =
  | 'launch_failed'
  | 'timeout'
  | 'navigation_error'
  | null;

/** Internal logger type so tests can inject a spy. */
export type Logger = {
  warn: (message: string, ...meta: unknown[]) => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Playwright-based URL extractor.
 *
 * Implements the same {@link Extractor} interface as the primary extractor so
 * it can be used as a drop-in replacement or fallback in the ingestion service.
 */
export class PlaywrightExtractor implements Extractor {
  private readonly config: Required<PlaywrightExtractorConfig>;
  private readonly logger: Logger;
  private readonly loadPlaywrightFn: () => Promise<BrowserModule>;

  /**
   * @param config         Browser configuration.
   * @param logger         Optional logger; defaults to `console`.
   * @param loadPlaywrightFn  Optional override for the playwright loader.
   *                       Inject a stub here in tests to avoid a real import.
   */
  constructor(
    config: PlaywrightExtractorConfig = {},
    logger?: Logger,
    loadPlaywrightFn?: () => Promise<BrowserModule>
  ) {
    this.config = {
      browser: config.browser ?? 'chromium',
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.logger = logger ?? console;
    this.loadPlaywrightFn = loadPlaywrightFn ?? loadPlaywright;
  }

  /**
   * Fetch and extract content from `url` using a headless browser.
   *
   * Returns an empty {@link ExtractResult} if Playwright is not installed,
   * the browser fails to launch, or navigation times out.
   */
  async extract(url: string): Promise<ExtractResult> {
    let browserModule: BrowserModule | null = null;

    // Dynamic import guard: fail gracefully if playwright is not installed.
    try {
      browserModule = await this.loadPlaywrightFn();
    } catch {
      this.logger.warn(
        '[PlaywrightExtractor] playwright package is not installed. ' +
          'Install it with: npm install playwright'
      );
      return { text: '', url };
    }

    const launcher = browserModule[this.config.browser];
    let browser: BrowserLike | null = null;

    try {
      browser = await launcher.launch({ headless: true });
    } catch (err) {
      this.logger.warn(
        '[PlaywrightExtractor] Failed to launch browser:',
        err instanceof Error ? err.message : err
      );
      return { text: '', url };
    }

    try {
      // Fresh context — no cookies, localStorage, or auth tokens.
      const context = await browser.newContext({
        storageState: undefined,
      });
      const page = await context.newPage();

      try {
        await page.goto(url, {
          timeout: this.config.timeoutMs,
          waitUntil: 'domcontentloaded',
        });
      } catch (err) {
        const isTimeout =
          err instanceof Error && err.message.includes('Timeout');
        const errorType: PlaywrightErrorType = isTimeout
          ? 'timeout'
          : 'navigation_error';
        this.logger.warn(
          `[PlaywrightExtractor] Navigation ${errorType} for ${url}:`,
          err instanceof Error ? err.message : err
        );
        return { text: '', url };
      }

      const html = await page.content();
      const title = await page.title().catch(() => undefined);
      // evaluate() runs in the browser context where `document` is available.
      // Cast through a minimal interface to avoid TypeScript's non-DOM lib
      // complaint without resorting to an untyped `any`.
      const text = await page.evaluate(() => {
        const g = globalThis as unknown as {
          document?: { body?: { innerText?: string } };
        };
        return g.document?.body?.innerText ?? '';
      });

      await context.close();

      return { text, html, title, url };
    } finally {
      try {
        await browser.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal browser-module loading abstraction (facilitates testing)
// ---------------------------------------------------------------------------

/** Minimal shape of a Playwright browser launcher we use. */
export interface BrowserTypeLike {
  launch(options: { headless: boolean }): Promise<BrowserLike>;
}

/** Minimal shape of a Playwright Browser we use. */
export interface BrowserLike {
  newContext(options: { storageState: undefined }): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

/** Minimal shape of a Playwright BrowserContext we use. */
export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/** Minimal shape of a Playwright Page we use. */
export interface PageLike {
  goto(url: string, options: { timeout: number; waitUntil: string }): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
}

/** The subset of the playwright module that PlaywrightExtractor uses. */
export interface BrowserModule {
  chromium: BrowserTypeLike;
  firefox: BrowserTypeLike;
  webkit: BrowserTypeLike;
}

/**
 * Load the playwright module.
 *
 * Isolated into a separate function so callers can override it at construction
 * time (via the `loadPlaywrightFn` constructor parameter) without needing to
 * actually install playwright.
 *
 * The `any` cast is intentional: `playwright` is an optional peer dependency
 * that may not be present at compile time, so its types are unavailable.
 * The {@link BrowserModule} interface documents the exact subset we rely on.
 *
 * @internal
 */
export async function loadPlaywright(): Promise<BrowserModule> {
  // playwright is an optional peer dependency; the cast is deliberate.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import('playwright' as any)) as BrowserModule;
  return mod;
}
