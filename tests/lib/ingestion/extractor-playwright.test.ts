/**
 * Unit tests for src/lib/ingestion/extractor-playwright.ts
 *
 * Tests exercise the PlaywrightExtractor class using stubbed browser
 * objects injected via the constructor's `loadPlaywrightFn` parameter.
 * No real browser is launched and playwright is never imported.
 *
 * Testing strategy:
 * - `PlaywrightExtractor` accepts an optional `loadPlaywrightFn` in its
 *   constructor.  Tests pass a factory that returns controlled fake browser
 *   implementations instead of a real playwright module.
 * - This matches the "mock/stub" option described in the issue's CI/Testing
 *   Strategy section and avoids ESM spy limitations.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PlaywrightExtractor,
  type BrowserModule,
  type BrowserTypeLike,
  type BrowserLike,
  type BrowserContextLike,
  type PageLike,
} from '../../../src/lib/ingestion/extractor-playwright.js';

// ---------------------------------------------------------------------------
// Helpers: minimal browser stubs
// ---------------------------------------------------------------------------

function buildPageStub(overrides: Partial<PageLike> = {}): PageLike {
  return {
    goto: vi.fn(async () => null),
    content: vi.fn(async () => '<html><body><p>Playwright content</p></body></html>'),
    title: vi.fn(async () => 'Playwright Page'),
    evaluate: vi.fn(async () => 'Playwright content'),
    ...overrides,
  };
}

function buildContextStub(page: PageLike): BrowserContextLike {
  return {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
}

function buildBrowserStub(context: BrowserContextLike): BrowserLike {
  return {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
}

function buildLauncherStub(browser: BrowserLike): BrowserTypeLike {
  return {
    launch: vi.fn(async () => browser),
  };
}

function buildBrowserModule(chromium: BrowserTypeLike): BrowserModule {
  return {
    chromium,
    firefox: buildLauncherStub(buildBrowserStub(buildContextStub(buildPageStub()))),
    webkit: buildLauncherStub(buildBrowserStub(buildContextStub(buildPageStub()))),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlaywrightExtractor', () => {

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns extracted text and html from a successful navigation', async () => {
    const page = buildPageStub({
      content: vi.fn(async () => '<html><body><p>JS content</p></body></html>'),
      title: vi.fn(async () => 'JS Page'),
      evaluate: vi.fn(async () => 'JS content'),
    });
    const launcher = buildLauncherStub(buildBrowserStub(buildContextStub(page)));
    const extractor = new PlaywrightExtractor(
      {},
      { warn: vi.fn() },
      async () => buildBrowserModule(launcher)
    );

    const result = await extractor.extract('https://example.com');

    expect(result.text).toBe('JS content');
    expect(result.html).toContain('JS content');
    expect(result.title).toBe('JS Page');
    expect(result.url).toBe('https://example.com');
  });

  it('uses a fresh browser context (storageState is undefined)', async () => {
    const page = buildPageStub();
    const context = buildContextStub(page);
    const browser = buildBrowserStub(context);
    const launcher = buildLauncherStub(browser);
    const extractor = new PlaywrightExtractor(
      {},
      { warn: vi.fn() },
      async () => buildBrowserModule(launcher)
    );

    await extractor.extract('https://example.com');

    expect(browser.newContext).toHaveBeenCalledWith({ storageState: undefined });
  });

  it('closes the browser even when navigation succeeds', async () => {
    const page = buildPageStub();
    const context = buildContextStub(page);
    const browser = buildBrowserStub(context);
    const launcher = buildLauncherStub(browser);
    const extractor = new PlaywrightExtractor(
      {},
      { warn: vi.fn() },
      async () => buildBrowserModule(launcher)
    );

    await extractor.extract('https://example.com');

    expect(browser.close).toHaveBeenCalled();
  });

  it('passes headless:true to browser.launch', async () => {
    const page = buildPageStub();
    const context = buildContextStub(page);
    const browser = buildBrowserStub(context);
    const launcher = buildLauncherStub(browser);
    const extractor = new PlaywrightExtractor(
      {},
      { warn: vi.fn() },
      async () => buildBrowserModule(launcher)
    );

    await extractor.extract('https://example.com');

    expect(launcher.launch).toHaveBeenCalledWith({ headless: true });
  });

  it('passes configured timeout to page.goto', async () => {
    const page = buildPageStub();
    const context = buildContextStub(page);
    const browser = buildBrowserStub(context);
    const launcher = buildLauncherStub(browser);
    const extractor = new PlaywrightExtractor(
      { timeoutMs: 5000 },
      { warn: vi.fn() },
      async () => buildBrowserModule(launcher)
    );

    await extractor.extract('https://example.com');

    expect(page.goto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ timeout: 5000 })
    );
  });

  // -------------------------------------------------------------------------
  // Graceful degradation: playwright not installed
  // -------------------------------------------------------------------------

  it('returns empty result and warns when playwright is not installed', async () => {
    const warnSpy = vi.fn();
    const extractor = new PlaywrightExtractor(
      {},
      { warn: warnSpy },
      async () => { throw new Error("Cannot find module 'playwright'"); }
    );

    const result = await extractor.extract('https://example.com');

    expect(result.text).toBe('');
    expect(result.url).toBe('https://example.com');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('playwright package is not installed')
    );
  });

  // -------------------------------------------------------------------------
  // Graceful degradation: launch failure
  // -------------------------------------------------------------------------

  it('returns empty result and warns when browser fails to launch', async () => {
    const warnSpy = vi.fn();
    const launcher: BrowserTypeLike = {
      launch: vi.fn(async () => { throw new Error('Executable not found'); }),
    };
    const extractor = new PlaywrightExtractor(
      {},
      { warn: warnSpy },
      async () => buildBrowserModule(launcher)
    );

    const result = await extractor.extract('https://example.com');

    expect(result.text).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to launch browser'),
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // Graceful degradation: navigation timeout
  // -------------------------------------------------------------------------

  it('returns empty result and warns on navigation timeout', async () => {
    const warnSpy = vi.fn();
    const page = buildPageStub({
      goto: vi.fn(async () => { throw new Error('Timeout exceeded'); }),
    });
    const extractor = new PlaywrightExtractor(
      {},
      { warn: warnSpy },
      async () => buildBrowserModule(
        buildLauncherStub(buildBrowserStub(buildContextStub(page)))
      )
    );

    const result = await extractor.extract('https://example.com');

    expect(result.text).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/timeout|navigation_error/i),
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // Graceful degradation: navigation error (non-timeout)
  // -------------------------------------------------------------------------

  it('returns empty result and warns on non-timeout navigation error', async () => {
    const warnSpy = vi.fn();
    const page = buildPageStub({
      goto: vi.fn(async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); }),
    });
    const extractor = new PlaywrightExtractor(
      {},
      { warn: warnSpy },
      async () => buildBrowserModule(
        buildLauncherStub(buildBrowserStub(buildContextStub(page)))
      )
    );

    const result = await extractor.extract('https://example.com');

    expect(result.text).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('navigation_error'),
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // Browser channel selection
  // -------------------------------------------------------------------------

  it('uses firefox when configured', async () => {
    const firefoxPage = buildPageStub({
      evaluate: vi.fn(async () => 'Firefox content'),
    });
    const firefoxLauncher = buildLauncherStub(
      buildBrowserStub(buildContextStub(firefoxPage))
    );

    const mod: BrowserModule = {
      chromium: buildLauncherStub(buildBrowserStub(buildContextStub(buildPageStub()))),
      firefox: firefoxLauncher,
      webkit: buildLauncherStub(buildBrowserStub(buildContextStub(buildPageStub()))),
    };

    const extractor = new PlaywrightExtractor(
      { browser: 'firefox' },
      { warn: vi.fn() },
      async () => mod
    );
    const result = await extractor.extract('https://example.com');

    expect(firefoxLauncher.launch).toHaveBeenCalled();
    expect(result.text).toBe('Firefox content');
  });
});
