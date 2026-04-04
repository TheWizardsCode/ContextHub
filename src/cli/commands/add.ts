/**
 * `ob add <url>` CLI command.
 *
 * Ingests content from a URL using the fast-path primary extractor, falling
 * back to a Playwright headless-browser fetch when:
 *   - The Playwright fallback is explicitly enabled (via config or environment
 *     variable `OB_PLAYWRIGHT_FALLBACK=1`), AND
 *   - The primary extractor returns fewer characters than the configured
 *     minimum content length threshold.
 *
 * Usage:
 *   ob add <url> [--playwright-fallback] [--min-content-length <n>] [--timeout <ms>]
 *
 * The command writes the ingested content to stdout (or a file if `--output`
 * is provided) in a format compatible with the downstream ingestion pipeline.
 * It exits with a non-zero status code only on unrecoverable errors (e.g. an
 * invalid URL); partial or empty content from a gracefully-degraded fetch is
 * not treated as a fatal error.
 */

import { IngestionService, type IngestionConfig } from '../../lib/ingestion/service.js';
import { FetchExtractor } from '../../lib/ingestion/extractor-fetch.js';
import { PlaywrightExtractor, type PlaywrightBrowserChannel } from '../../lib/ingestion/extractor-playwright.js';
import type { ExtractResult } from '../../lib/ingestion/extractor.js';
import * as fs from 'fs';

/** Options accepted by the `add` command. */
export interface AddCommandOptions {
  /** Enable the Playwright fallback (overrides config). */
  playwrightFallback?: boolean;
  /** Minimum content length before fallback is triggered. */
  minContentLength?: number;
  /** Playwright navigation timeout in milliseconds. */
  timeout?: number;
  /** Browser channel to use for Playwright. */
  browser?: PlaywrightBrowserChannel;
  /** Write output to this file path instead of stdout. */
  output?: string;
  /**
   * Injectable file-write function for testing.
   * Defaults to `fs.writeFileSync` when not provided.
   * @internal
   */
  _writeFile?: (path: string, data: string, encoding: BufferEncoding) => void;
}

/**
 * Dependency-injectable runner for the `add` command.
 *
 * Separated from Commander.js setup so it can be unit-tested without starting
 * a real CLI process.
 *
 * @param url The URL to ingest.
 * @param options Command options.
 * @returns The ingested {@link ExtractResult}.
 */
export async function runAdd(
  url: string,
  options: AddCommandOptions = {}
): Promise<ExtractResult> {
  if (!url) {
    throw new Error('URL is required');
  }

  const ingestionConfig: IngestionConfig = {
    playwrightFallback: options.playwrightFallback ?? false,
    minContentLength: options.minContentLength,
  };

  const playwrightExtractor = new PlaywrightExtractor({
    browser: options.browser ?? 'chromium',
    timeoutMs: options.timeout ?? 30_000,
  });

  const service = new IngestionService(
    new FetchExtractor(),
    playwrightExtractor,
    ingestionConfig
  );

  const result = await service.ingest(url);

  if (options.output) {
    const writeFile = options._writeFile ?? fs.writeFileSync;
    writeFile(options.output, result.text, 'utf8');
  } else {
    process.stdout.write(result.text);
    if (result.text.length > 0 && !result.text.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Commander.js registration (optional — used when loaded as a plugin command)
// ---------------------------------------------------------------------------

/**
 * Register the `add` command with a Commander.js program.
 *
 * This function follows the same pattern as other commands in `src/commands/`.
 *
 * @param program The root Commander.js Command instance.
 */
export function registerAddCommand(program: {
  command: (name: string) => CommandBuilder;
}): void {
  program
    .command('add <url>')
    .description('Ingest content from a URL (with optional Playwright fallback for JS-heavy pages)')
    .option(
      '--playwright-fallback',
      'Enable Playwright headless-browser fallback (requires `playwright` package)',
      false
    )
    .option(
      '--min-content-length <n>',
      'Minimum character count before Playwright fallback is triggered',
      '200'
    )
    .option(
      '--timeout <ms>',
      'Playwright navigation timeout in milliseconds',
      '30000'
    )
    .option(
      '--browser <channel>',
      'Playwright browser channel: chromium | firefox | webkit',
      'chromium'
    )
    .option('--output <file>', 'Write ingested content to file instead of stdout')
    .action(async (url: string, opts: Record<string, string | boolean>) => {
      const parsePositiveInt = (
        raw: string | boolean | undefined,
        name: string
      ): number | undefined => {
        if (raw === undefined || raw === false || raw === '') return undefined;
        const n = parseInt(String(raw), 10);
        if (isNaN(n) || n <= 0) {
          process.stderr.write(
            `[ob add] Error: --${name} must be a positive integer (received: ${String(raw)})\n`
          );
          process.exit(1);
        }
        return n;
      };

      const options: AddCommandOptions = {
        playwrightFallback: Boolean(opts['playwrightFallback']),
        minContentLength: parsePositiveInt(opts['minContentLength'], 'min-content-length'),
        timeout: parsePositiveInt(opts['timeout'], 'timeout'),
        browser: opts['browser'] as PlaywrightBrowserChannel | undefined,
        output: opts['output'] ? String(opts['output']) : undefined,
      };

      try {
        await runAdd(url, options);
      } catch (err) {
        process.stderr.write(
          `[ob add] Error: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// Minimal type shim for Commander.js .option / .action chaining
// (avoids requiring a Commander.js type import in this standalone module)
// ---------------------------------------------------------------------------

interface CommandBuilder {
  description: (desc: string) => CommandBuilder;
  option: (flags: string, description: string, defaultValue?: string | boolean) => CommandBuilder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: (fn: (...args: any[]) => void | Promise<void>) => CommandBuilder;
}
